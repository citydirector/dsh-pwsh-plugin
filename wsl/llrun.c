/*
 * llrun —— WSL 里 bash 的写边界护栏（DSH bash 工具的 landlock 垫片）
 *
 * 背景
 *   DSH 的 bash 工具跑 WSL Debian，9p/drvfs 挂载不受 DSH 沙箱约束，
 *   /mnt/c、/mnt/d 任意位置都能写。本程序在 exec 目标 shell 之前加边界：
 *
 *   1) user + mount namespace（默认开，--no-isolate 关闭）：
 *      把危险 unix socket 换成 /dev/null。
 *      /run/docker.sock 这类 socket 不受 landlock 管，是唯一实测成功的逃逸口
 *      （docker run -v /mnt/d:/host 能直接把文件写到 Windows 盘上）。
 *      代价：userns 只映射当前 uid，其余属主在 ns 内显示为 65534，
 *      导致 ssh 之类的「配置文件属主必须正确」检查失败，sudo 也不可用。
 *   2) landlock（ABI 7）：文件系统白名单
 *      - 系统目录全权限（/usr /etc /var /tmp /dev /proc /sys /run /home ...）
 *      - /mnt/c /mnt/d /mnt/e 只读（EXECUTE | READ_FILE | READ_DIR）
 *      - 工作区可写（显式传入，或 "-" 表示当前工作目录；-r 降为只读）
 *      - 白名单不含 /init → WSL interop 失效 → cmd.exe / pwsh.exe / 任意 PE 全部无法执行
 *        （这是关键：interop 一开，所有写限制形同虚设，实测 cmd.exe 能直接写 D:\）
 *      代价：landlock 要求 PR_SET_NO_NEW_PRIVS，setuid 提权（sudo）从此不可用。
 *   3) /var/tmp 挂载封印（默认开）：
 *      在 userns 的 mountns 内 bind 自身后 remount,ro。
 *      landlock 封不住子目录——父子规则取并集，"/var 全权" 会吞掉 "/var/tmp 只读"，
 *      只有 mount 能精细封印。/var/tmp 是 ext4 磁盘、本机无程序依赖它，
 *      封掉零代价（SemLock / SharedMemory / gcc / git / curl 实测全正常）。
 *      /tmp 与 /dev/shm 必须保留：/tmp 是所有工具的默认临时目录，
 *      /dev/shm 是 POSIX 共享内存挂载点，封掉后 python multiprocessing 直接崩。
 *
 * 用法
 *   llrun [--no-isolate] [--no-seal] [-r] [-C <dir>] <workspace|-> <prog> [args...]
 *     --no-isolate 不做 socket 掩蔽（docker 口子保持连通），同时也不做 /var/tmp 封印
 *     --no-seal    只关 /var/tmp 封印，socket 掩蔽照旧
 *     -r           严格只读（对应 DSH 的 read-only 模式）：除 /dev 外全部目录降为
 *                  只读（读/列目录/执行照常，写入/新建/删除/重命名全部拒绝），
 *                  工作区同样只读。/dev 必须留全权——/dev/null 是字符设备，
 *                  landlock 无法单独授权，封掉后连 "echo x > /dev/null" 都失败；
 *                  代价是 /dev/shm 被父规则并集带成可写，所以 -r 档额外用 mount 封它。
 *     -C <dir>     landlock 生效后 chdir 到该目录（等价 cd，但不污染脚本的 $0 与行号）
 *     workspace    可写目录（WSL 路径）；传 '-' 表示当前工作目录
 *     prog         目标程序，之后的 argv 原样传递（不经过任何 shell）
 *
 * 退出码
 *   exec 成功时进程直接变成 prog，退出码/信号/标准流全部透传。
 *   126 = 护栏自身初始化失败（规则集创建或 restrict 失败）；127 = exec 失败。
 *   若 user namespace 不可用，打印警告后仍继续——landlock 依然生效，
 *   只是 docker.sock 这类 unix socket 逃逸口没被封（降级而非失效）。
 *
 * 编译
 *   gcc -O2 -o llrun llrun.c
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/landlock.h>

/* 全权限目录：程序、库、配置、包数据库、临时区、设备、内核接口。 */
static const char *const FULL_ACCESS[] = {
  "/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32",
  "/etc", "/var", "/srv", "/media", "/root",
  "/tmp", "/dev", "/proc", "/sys", "/run",
  "/opt", "/home", "/usr/local", "/snap", "/boot",
  NULL
};

/* 只读挂载点：Windows 盘整体只读，读取与列目录照常。 */
static const char *const READ_ONLY[] = {
  "/mnt/c", "/mnt/d", "/mnt/e", "/mnt/wsl", "/mnt/wslg", "/mnt",
  NULL
};

/* 需要封印成只读的目录：landlock 管不到子目录，只能靠 mount 层面降权。 */
static const char *const SEAL_RO[] = {
  "/var/tmp",
  NULL
};

/*
 * -r 严格档额外要封的：/dev 必须全权（/dev/null 是字符设备），而 landlock 的父子规则
 * 取并集，"/dev 全权" 会把 "/dev/shm 只读" 吞掉，只能靠 mount 降权。
 */
static const char *const SEAL_RO_STRICT[] = {
  "/dev/shm",
  NULL
};

/* 需要屏蔽的 unix socket：连接它们等于把写操作外包给不受 landlock 约束的守护进程。 */
static const char *const MASK[] = {
  "/run/docker.sock",
  "/run/docker.pid",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
  NULL
};

static int writeAll(const char *path, const char *data) {
  int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = write(fd, data, strlen(data));
  close(fd);
  return n == (ssize_t)strlen(data) ? 0 : -1;
}

/*
 * 进入 user + mount namespace 并把危险 socket 掩成 /dev/null。
 * 必须在 landlock 之前做：landlock 不可回退，而 mount 需要权限。
 */
static int isolateSockets(void) {
  /* unshare 之后 getuid() 会变成 65534，真实 uid 必须提前取。 */
  uid_t uid = getuid();
  gid_t gid = getgid();
  char map[64];

  if (unshare(CLONE_NEWUSER) != 0) return -1;

  writeAll("/proc/self/setgroups", "deny");
  /*
   * 同 uid 映射（1000 -> 1000）而不是 0 -> 1000：
   * 后者会把调用者变成 ns 内 root，HOME 里的文件全部显示成 65534，
   * ssh 读 ~/.ssh 直接 Permission denied；前者保持调用者身份，只丢了 root 的映射
   * （sudo 本来就因 NO_NEW_PRIVS 不可用，无损失）。
   */
  snprintf(map, sizeof(map), "%d %d 1", (int)uid, (int)uid);
  if (writeAll("/proc/self/uid_map", map) != 0) return -1;
  snprintf(map, sizeof(map), "%d %d 1", (int)gid, (int)gid);
  if (writeAll("/proc/self/gid_map", map) != 0) return -1;

  if (unshare(CLONE_NEWNS) != 0) return -1;
  if (mount(NULL, "/", "", MS_REC | MS_PRIVATE, NULL) != 0) return -1;

  for (int i = 0; MASK[i] != NULL; i++) {
    if (access(MASK[i], F_OK) == 0) mount("/dev/null", MASK[i], "", MS_BIND, NULL);
  }

  /*
   * ssh 会检查 /etc/ssh/ssh_config.d 下每个 .conf 的属主必须是自己，
   * 而 userns 里这些文件属于未映射的 root，一律显示 65534
   * → ssh 直接 "Bad owner or permissions" 拒绝启动。
   * 用一个空目录盖掉整个片段目录：ssh 回到内置默认配置，连接照常。
   */
  /*
   * 用固定路径而不是 mkdtemp：mkdtemp 每次调用都留一个空目录在 /tmp，
   * 几百次调用后就是几百个 .llrun-empty-* 垃圾（实测 421 个）。
   * 固定路径在 ns 内 bind 到 /etc/ssh/ssh_config.d 后，进程退出 bind 消失、
   * 宿主 /tmp 里只留这一个目录，且可以被复用。
   */
  static const char *const emptyDir = "/tmp/.llrun-empty";
  if (mkdir(emptyDir, 0700) == 0 || errno == EEXIST) {
    if (mount(emptyDir, "/etc/ssh/ssh_config.d", "", MS_BIND, NULL) != 0) {
      /* 覆盖失败不致命，只是 ssh 会报属主警告。 */
    }
  }
  return 0;
}

/*
 * 把 SEAL_RO 里的目录 bind 到自身再 remount 成只读。
 *
 * 为什么必须用 mount 而不是 landlock：
 *   landlock 的父子规则取并集，"/var 全权" 会吞掉 "/var/tmp 只读" 这条更严格的规则
 *   （/dev 全权 + /dev/shm 只读同理，实测均仍可写）。
 *   只有 mount 层的 ro 能精细封印子目录，而 remount 要求 CAP_SYS_ADMIN —— 只能在
 *   userns 内做，所以这个函数必须排在 unshare(CLONE_NEWUSER) 之后。
 *
 * 失败返回 -1，由调用方降级为警告（与 userns 不可用同样处理）。
 */
static int sealOne(const char *dir) {
  struct stat st;
  if (stat(dir, &st) != 0 || !S_ISDIR(st.st_mode)) return 0;
  if (mount(dir, dir, "", MS_BIND | MS_REC, NULL) != 0) return -1;
  if (mount(NULL, dir, "", MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL) != 0) {
    return -1;
  }
  return 0;
}

static int sealReadOnlyDirs(int strict) {
  for (int i = 0; SEAL_RO[i] != NULL; i++) {
    if (sealOne(SEAL_RO[i]) != 0) return -1;
  }
  if (strict) {
    for (int i = 0; SEAL_RO_STRICT[i] != NULL; i++) {
      if (sealOne(SEAL_RO_STRICT[i]) != 0) return -1;
    }
  }
  return 0;
}

static void allowPath(int ruleset, const char *path, __u64 access) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) return;
  struct landlock_path_beneath_attr rule;
  memset(&rule, 0, sizeof(rule));
  rule.allowed_access = access;
  rule.parent_fd = fd;
  syscall(445 /* LANDLOCK_ADD_RULE */, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  close(fd);
}

int main(int argc, char **argv) {
  int argi = 1;
  int workspaceReadOnly = 0;
  int isolate = 1;
  int seal = 1;
  const char *chdirTo = NULL;

  for (;;) {
    if (argi < argc && strcmp(argv[argi], "-r") == 0) {
      workspaceReadOnly = 1;
      argi++;
      continue;
    }
    if (argi < argc && strcmp(argv[argi], "--no-isolate") == 0) {
      isolate = 0;
      argi++;
      continue;
    }
    if (argi < argc && strcmp(argv[argi], "--no-seal") == 0) {
      seal = 0;
      argi++;
      continue;
    }
    if (argi + 1 < argc && strcmp(argv[argi], "-C") == 0) {
      chdirTo = argv[argi + 1];
      argi += 2;
      continue;
    }
    break;
  }

  if (argc - argi < 2) {
    fprintf(stderr, "usage: llrun [--no-isolate] [--no-seal] [-r] [-C <dir>] <workspace|-> <prog> [args...]\n");
    return 126;
  }

  /* 工作区路径必须在 landlock 之前解析：restrict 之后 /mnt 只剩只读权限。 */
  char cwdBuf[PATH_MAX];
  const char *workspace = argv[argi];
  if (strcmp(workspace, "-") == 0) {
    if (getcwd(cwdBuf, sizeof(cwdBuf)) == NULL) {
      fprintf(stderr, "llrun: getcwd failed: %s\n", strerror(errno));
      return 126;
    }
    workspace = cwdBuf;
  }
  /* 拒绝把根目录当工作区，否则等于没有边界。 */
  if (workspace[0] != '/' || strlen(workspace) < 2) {
    fprintf(stderr, "llrun: refusing workspace '%s'\n", workspace);
    return 126;
  }

  int nsReady = 1;
  if (isolate) {
    if (isolateSockets() != 0) {
      nsReady = 0;
      fprintf(stderr,
              "llrun: warning: user namespace unavailable; unix sockets (e.g. docker) stay reachable\n");
    }
  } else {
    /* --no-isolate 没有 userns，也就没有 CAP_SYS_ADMIN，封印同样做不了。 */
    nsReady = 0;
  }

  /*
   * 封印必须在 landlock 之前：mount 需要权限，而 landlock restrict 之后
   * 白名单外的路径连 stat 都可能失败。封印失败不致命，只降级并告警。
   */
  if (seal) {
    if (!nsReady) {
      if (isolate) {
        fprintf(stderr, "llrun: warning: /var/tmp not sealed (no user namespace)\n");
      }
    } else if (sealReadOnlyDirs(workspaceReadOnly) != 0) {
      fprintf(stderr, "llrun: warning: sealing failed: %s\n", strerror(errno));
    }
  }

  /* landlock ABI 1..7 的位全开（bit0..bit14 覆盖到 REFER/TRUNCATE）。 */
  __u64 all = 0;
  for (int bit = 0; bit <= 14; bit++) all |= (1ULL << bit);
  const __u64 readExecute = (1ULL << 0) | (1ULL << 2) | (1ULL << 3); /* EXECUTE|READ_FILE|READ_DIR */

  struct landlock_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = all;
  int ruleset = syscall(444 /* LANDLOCK_CREATE_RULESET */, &attr, sizeof(attr), 0);
  if (ruleset < 0) {
    fprintf(stderr, "llrun: landlock unavailable: %s\n", strerror(errno));
    return 126;
  }

  if (workspaceReadOnly) {
    /*
     * 严格只读：系统目录一律降到 readExecute（读文件 / 列目录 / 执行照常）。
     * 读权限必须保留——没有它连 ls、cat、gcc 都起不来，read-only 会变成 unusable。
     */
    for (int i = 0; FULL_ACCESS[i] != NULL; i++) allowPath(ruleset, FULL_ACCESS[i], readExecute);
    /* 唯一例外：/dev 全权。字符设备无法单独授权，见头注释。 */
    allowPath(ruleset, "/dev", all);
  } else {
    for (int i = 0; FULL_ACCESS[i] != NULL; i++) allowPath(ruleset, FULL_ACCESS[i], all);
  }
  for (int i = 0; READ_ONLY[i] != NULL; i++) allowPath(ruleset, READ_ONLY[i], readExecute);

  /* 工作区。注意 /init 永远不进白名单——这是封死 Windows exe 的关键。 */
  allowPath(ruleset, workspace, workspaceReadOnly ? readExecute : all);

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "llrun: PR_SET_NO_NEW_PRIVS failed: %s\n", strerror(errno));
    return 126;
  }
  if (syscall(446 /* LANDLOCK_RESTRICT_SELF */, ruleset, 0) != 0) {
    fprintf(stderr, "llrun: landlock restrict failed: %s\n", strerror(errno));
    return 126;
  }
  close(ruleset);

  if (chdirTo != NULL && chdir(chdirTo) != 0) {
    fprintf(stderr, "llrun: chdir %s failed: %s\n", chdirTo, strerror(errno));
    return 126;
  }

  execv(argv[argi + 1], &argv[argi + 1]);
  fprintf(stderr, "llrun: exec %s failed: %s\n", argv[argi + 1], strerror(errno));
  return 127;
}
const ORIGINAL = Symbol.for('cordis.original')

/** Cordis 为调用点创建新代理；仅比较底层身份，服务调用仍须经原代理。 */
export function serviceIdentity(service) {
  return service?.[ORIGINAL] ?? service
}

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
const blocked = () => { throw new Error('NETWORK_TRIPWIRE') }
globalThis.fetch = blocked
http.request = blocked; http.get = blocked
https.request = blocked; https.get = blocked
net.Socket.prototype.connect = blocked
tls.connect = blocked
if (process.env.CSV_FORBID_KEY_READ === '1') {
  process.env = new Proxy(process.env, { get(target, name) {
    if (name === 'SOLARI_API_KEY') throw new Error('KEY_READ_TRIPWIRE')
    return Reflect.get(target, name)
  } })
}

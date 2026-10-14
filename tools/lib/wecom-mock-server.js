import { WebSocketServer } from 'ws';

export async function createWecomMockServer({ authErrcode = 0, ackErrcode = 0, ack = true } = {}) {
  const receivedFrames = []; const sockets = new Set(); let connectionCount = 0;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    sockets.add(socket); connectionCount += 1;
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()); receivedFrames.push(frame);
      const reqId = frame.headers?.req_id;
      if (!ack) return;
      if (frame.cmd === 'aibot_subscribe') return socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: authErrcode, errmsg: authErrcode ? 'auth failed' : 'ok' }));
      if (frame.cmd === 'ping') return socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }));
      if (frame.cmd === 'aibot_send_msg' || frame.cmd === 'aibot_respond_msg') socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: ackErrcode, errmsg: ackErrcode ? 'mock error' : 'ok' }));
    });
  });
  const address = wss.address();
  const url = `ws://127.0.0.1:${address.port}`;
  const send = (frame) => { for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(frame)); };
  return {
    url,
    received: () => [...receivedFrames],
    connections: () => connectionCount,
    pushMessage({ msgid = `msg-${Date.now()}`, chattype = 'single', userid = 'zhangsan_test', msgtype = 'text', content = '' } = {}) {
      const body = { msgid, chattype, from: { userid }, msgtype };
      if (msgtype === 'text') body.text = { content }; else if (msgtype === 'voice') body.voice = { content }; else if (msgtype === 'mixed') body.mixed = { msg_item: [{ msgtype: 'text', text: { content } }] }; else body[msgtype] = {};
      send({ cmd: 'aibot_msg_callback', headers: { req_id: `callback-${msgid}` }, body });
    },
    pushEvent(eventtype = 'disconnected_event') { send({ cmd: 'aibot_event_callback', headers: { req_id: `event-${Date.now()}` }, body: { msgid: `event-${Date.now()}`, msgtype: 'event', event: { eventtype } } }); },
    closeClients() { for (const socket of sockets) socket.close(); },
    async close() { for (const socket of sockets) socket.close(); await new Promise((resolve) => wss.close(resolve)); },
  };
}

export default createWecomMockServer;

import { WebSocketServer } from 'ws';

export async function createWecomMockServer({
  authErrcode = 0,
  authErrmsg = 'auth failed',
  ackErrcode = 0,
  ackErrmsg = 'mock error',
  ack = true,
  sendAck = ack,
  responseAck = ack,
  onFrame,
} = {}) {
  const receivedFrames = [];
  const sockets = new Set();
  let connectionCount = 0;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (socket) => {
    sockets.add(socket);
    connectionCount += 1;
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      receivedFrames.push(frame);
      onFrame?.(frame, socket);
      const reqId = frame.headers?.req_id;
      if (frame.cmd === 'aibot_subscribe') {
        if (!ack) return;
        socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: authErrcode, errmsg: authErrcode ? authErrmsg : 'ok' }));
        return;
      }
      if (frame.cmd === 'ping') {
        if (!ack) return;
        socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: 0, errmsg: 'ok' }));
        return;
      }
      if (frame.cmd === 'aibot_send_msg' || frame.cmd === 'aibot_respond_msg') {
        const shouldAck = frame.cmd === 'aibot_send_msg' ? sendAck : responseAck;
        if (!shouldAck) return;
        socket.send(JSON.stringify({ headers: { req_id: reqId }, errcode: ackErrcode, errmsg: ackErrcode ? ackErrmsg : 'ok' }));
      }
    });
  });
  const address = wss.address();
  const url = `ws://127.0.0.1:${address.port}`;
  const send = (frame) => {
    for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(frame));
  };
  return {
    url,
    received: () => [...receivedFrames],
    receivedBy: (cmd) => receivedFrames.filter((frame) => frame.cmd === cmd),
    connections: () => connectionCount,
    pushMessage({
      msgid = `msg-${Date.now()}`,
      chattype = 'single',
      userid = 'zhangsan_test',
      msgtype = 'text',
      content = '',
      items,
    } = {}) {
      const body = { msgid, chattype, from: { userid }, msgtype };
      if (msgtype === 'text') body.text = { content };
      else if (msgtype === 'voice') body.voice = { content };
      else if (msgtype === 'mixed') body.mixed = { msg_item: items || [{ msgtype: 'text', text: { content } }] };
      else body[msgtype] = {};
      send({ cmd: 'aibot_msg_callback', headers: { req_id: `callback-${msgid}` }, body });
    },
    pushEvent(eventtype = 'disconnected_event') {
      const msgid = `event-${Date.now()}`;
      send({ cmd: 'aibot_event_callback', headers: { req_id: msgid }, body: { msgid, msgtype: 'event', event: { eventtype } } });
    },
    closeClients() { for (const socket of [...sockets]) socket.close(); },
    terminateClients() { for (const socket of [...sockets]) socket.terminate(); },
    async close() {
      for (const socket of [...sockets]) socket.close();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

export default createWecomMockServer;

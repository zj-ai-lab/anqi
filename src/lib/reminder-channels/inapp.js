export default {
  id: 'inapp',
  label: '应用内通知',
  configured() { return true; },
  async deliver() { return { status: 'queued' }; },
};

import inapp from './inapp.js';

const channels = [inapp];
export function registerChannel(channel) {
  if (!channel || !channel.id || typeof channel.configured !== 'function' || typeof channel.deliver !== 'function') throw new Error('invalid reminder channel');
  if (channels.some((item) => item.id === channel.id)) throw new Error(`duplicate reminder channel: ${channel.id}`);
  channels.push(channel);
  return channel;
}
export function listChannels() { return [...channels]; }
export function configuredChannels(settings) { return channels.filter((channel) => channel.configured(settings)); }
export function getChannel(id) { return channels.find((channel) => channel.id === id) || null; }

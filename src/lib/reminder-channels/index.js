import inapp from './inapp.js';

const channels = [inapp];
export function listChannels() { return [...channels]; }
export function configuredChannels(settings) { return channels.filter((channel) => channel.configured(settings)); }
export function getChannel(id) { return channels.find((channel) => channel.id === id) || null; }

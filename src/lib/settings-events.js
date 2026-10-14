import { EventEmitter } from 'node:events';

export const settingsEvents = new EventEmitter();
settingsEvents.setMaxListeners(50);
export default settingsEvents;

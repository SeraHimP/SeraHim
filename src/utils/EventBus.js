export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const list = this.listeners.get(event);
    const idx = list.indexOf(callback);
    if (idx !== -1) list.splice(idx, 1);
  }

  emit(event, data) {
    if (!this.listeners.has(event)) return;
    for (const cb of this.listeners.get(event)) {
      try {
        cb(data);
      } catch (e) {
        console.error(`EventBus error in ${event}:`, e);
      }
    }
  }

  once(event, callback) {
    const wrapper = (data) => { callback(data); this.off(event, wrapper); };
    this.on(event, wrapper);
  }
}
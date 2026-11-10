/**
 * utils/eventBus.js —— 全局事件总线（发布/订阅）
 * ============================================================================
 * 【职责】全局事件总线（发布/订阅）。
 * 【依赖】无
 * 【注意事项】App 启动时挂到 globalData.eventBus；组件销毁时请取消订阅，避免内存泄漏。
 * ============================================================================
 */
const events = {};

export default {
  $on(eventName, callback) {
    if (!events[eventName]) events[eventName] = [];
    events[eventName].push(callback);
  },
  
  $emit(eventName, data) {
    const callbacks = events[eventName];
    callbacks && callbacks.forEach(cb => cb(data));
  },
  
  $off(eventName, callback) {
    const callbacks = events[eventName];
    if (callbacks) {
      events[eventName] = callbacks.filter(cb => cb !== callback);
    }
  }
};
/**
 * DebugLogger.js
 * 调试日志系统：独立于游戏内"战斗日志"（那个是给玩家看的），这个是给开发者用的。
 * 在内存里环形缓冲最近 N 条记录（游戏事件 + 拦截到的 console.error/warn/未捕获异常），
 * 提供"导出为文本文件"和"复制到剪贴板"，方便复现问题后直接把日志发过来定位。
 *
 * 设计原则：只做旁路记录，不影响任何游戏逻辑；所有操作都包一层 try-catch，
 * 即使日志系统本身出错也不能导致游戏崩溃。
 */
const MAX_ENTRIES = 2000; // v33：扩容（分类环形缓冲，导出文件用）

class DebugLoggerImpl {
  constructor() {
    this.entries = [];
    this._origError = console.error.bind(console);
    this._origWarn = console.warn.bind(console);
    this._hooked = false;
  }

  hookConsole() {
    if (this._hooked) return;
    this._hooked = true;
    console.error = (...args) => {
      this._push('error', args.map(a => this._stringify(a)).join(' '));
      this._origError(...args);
    };
    console.warn = (...args) => {
      this._push('warn', args.map(a => this._stringify(a)).join(' '));
      this._origWarn(...args);
    };
    window.addEventListener('error', (e) => {
      this._push('error', `未捕获异常: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      this._push('error', `未处理的Promise拒绝: ${this._stringify(e.reason)}`);
    });
  }

  _stringify(v) {
    try {
      if (v instanceof Error) return v.stack || v.message;
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch (e) { return '[无法序列化]'; }
  }

  log(category, message) {
    try { this._push(category, message); } catch (e) { /* 静默失败 */ }
  }

  _push(level, message) {
    const t = (typeof window !== 'undefined' && window.gameTime) ? window.gameTime.toFixed(1) : '?';
    this.entries.push({ ts: Date.now(), gameTime: t, level, message });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  toText() {
    const header = [
      `=== 调试日志导出 ===`,
      `导出时间: ${new Date().toLocaleString()}`,
      `游戏内时间: ${(window.gameTime || 0).toFixed(1)}s`,
      `当前模式: ${window.__app?.mapSystem?.active ? '对战模式' : '沙盒模式'}`,
      `塔数: ${window.__app?.entityContainer?.getAllTowers?.(true)?.length ?? '?'}`,
      `小兵数: ${window.__app?.entityContainer?.getAllMinions?.(true)?.length ?? '?'}`,
      `====================`,
      '',
    ].join('\n');
    const body = this.entries.map(e => `[${e.gameTime}s][${e.level}] ${e.message}`).join('\n');
    return header + body;
  }

  downloadAsFile() {
    try {
      const text = this.toText();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `debug-log-${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) { console.error('导出日志失败:', e); return false; }
  }

  async copyToClipboard() {
    try {
      await navigator.clipboard.writeText(this.toText());
      return true;
    } catch (e) {
      console.error('复制日志失败:', e);
      return false;
    }
  }

  clear() {
    this.entries = [];
  }
}

export const DebugLogger = new DebugLoggerImpl();

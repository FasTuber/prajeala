/**
 * Tiny DOM diagnostics panel (top-left, monospace, click-through).
 */

export class DebugHud {
  private el: HTMLElement | null = null;
  private visible = false;
  private lastText = '';

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && !this.el) this.el = this.create();
    if (this.el) this.el.style.display = visible ? 'block' : 'none';
  }

  get isVisible(): boolean {
    return this.visible;
  }

  update(lines: readonly string[]): void {
    if (!this.visible || !this.el) return;
    const text = lines.join('\n');
    if (text === this.lastText) return;
    this.lastText = text;
    this.el.textContent = text;
  }

  private create(): HTMLElement {
    const el = document.createElement('pre');
    el.id = 'prajeala-hud';
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      margin: '0',
      padding: '6px 8px',
      font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace',
      color: '#ffd9a0',
      background: 'rgba(0, 0, 0, 0.55)',
      border: '1px solid rgba(255, 140, 40, 0.45)',
      borderRadius: '4px',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre',
      zIndex: '2147483647',
      textShadow: '0 1px 1px #000',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    return el;
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }
}

type Command = Record<string, unknown>;
/** Remember only inputs held by this viewer so leaving control releases them. */
export class RemoteHeldInput {
  private keys = new Set<string>();
  private buttons = new Map<string, { x: number; y: number }>();
  keyDown(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key); return true;
  }
  keyUp(key: string): boolean { return this.keys.delete(key); }
  buttonDown(button: string, point: { x: number; y: number }) { this.buttons.set(button, point); }
  buttonUp(button: string): boolean { return this.buttons.delete(button); }
  move(point: { x: number; y: number }) { for (const button of this.buttons.keys()) this.buttons.set(button, point); }
  releaseButtons(): Command[] {
    const commands = [...this.buttons].map(([button, point]) => ({ type: "MouseUp", button, ...point }));
    this.buttons.clear(); return commands;
  }
  releaseAll(): Command[] {
    const commands = [...this.keys].map(key => ({ type: "KeyUp", key }));
    this.keys.clear(); return [...commands, ...this.releaseButtons()];
  }
}

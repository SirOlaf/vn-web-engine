/** MMotionDevice+0x1fc is shared by the DLL's live device wrappers, initially alpha mode1. */
export class EmoteD3d11MaskState {
  mode = 1;
  private users = 0;

  retain(): void {
    if (this.users++ === 0) this.mode = 1;
  }
  release(): void {
    if (this.users === 0) throw new Error('Unbalanced E-mote mask state release');
    this.users--;
  }
}

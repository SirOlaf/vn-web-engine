/** SetWindowTextW-like effect for the selected native window. Failure is reported
 * to the owner; the browser mapping changes that window's Document.title.
 */
export interface WindowCaptionHost {
  setCaption(title: string): boolean;
}

export class BrowserWindowCaptionHost implements WindowCaptionHost {
  constructor(private readonly document: Pick<Document, 'title'> | null) {}
  setCaption(title: string): boolean {
    if (!this.document) return false;
    this.document.title = title.split('\0', 1)[0]!;
    return true;
  }
}

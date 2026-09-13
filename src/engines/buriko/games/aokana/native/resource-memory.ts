/** An unsafe native read has no reproducible value; it must never become invented asset bytes. */
export class AokanaUndefinedResourceRead extends Error {}

/** An explicit native codec exception is caught by the resource wrapper as status5. */
export class AokanaResourceCodecException extends Error {
  constructor(readonly code: number, message: string) {super(message);}
}

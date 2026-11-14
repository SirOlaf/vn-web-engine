/** A native operation outside the supported surface of the selected driver image. */
export class EmoteUnsupportedError extends Error {
  constructor(feature: string) {
    super(`E-mote: ${feature} is not supported`);
    this.name = 'EmoteUnsupportedError';
  }
}

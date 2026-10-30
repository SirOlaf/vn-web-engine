import {
  ArtemisTheoraThreadService,
  type ArtemisTheoraThreadRequest,
  type ArtemisTheoraThreadResponse,
} from './video-thread.js';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArtemisTheoraThreadRequest>) => void) | null;
  postMessage(value: ArtemisTheoraThreadResponse, transfers: Transferable[]): void;
};
const service = new ArtemisTheoraThreadService();
scope.onmessage = ({data}) => {
  const response = service.handle(data);
  scope.postMessage(
    response,
    response.type === 'state' && response.picture ? [response.picture] : [],
  );
};

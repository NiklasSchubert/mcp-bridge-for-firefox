/**
 * Minimal ambient typings for the Firefox WebExtension APIs this extension
 * actually uses. Hand-written to avoid a heavy @types dependency.
 */

interface HarHeader {
  name: string;
  value: string;
}

interface HarRequest {
  method: string;
  url: string;
  headers: HarHeader[];
  postData?: { text?: string; mimeType?: string };
}

interface HarResponse {
  status: number;
  headers: HarHeader[];
  content?: { mimeType?: string; size?: number };
  bodySize?: number;
  _transferSize?: number;
}

interface HarEntry {
  request: HarRequest;
  response: HarResponse;
  startedDateTime: string;
  time?: number;
  _resourceType?: string;
  getContent(): Promise<[content: string, mimeType: string]>;
}

interface HarLog {
  entries: HarEntry[];
}

interface RuntimePort {
  name: string;
  postMessage(msg: unknown): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

interface EvalExceptionInfo {
  isException?: boolean;
  value?: unknown;
  isError?: boolean;
  code?: string;
}

interface CaptureOptions {
  format?: "png" | "jpeg";
  quality?: number;
  rect?: { x: number; y: number; width: number; height: number };
  scale?: number;
}

interface Browser {
  runtime: {
    connect(info: { name: string }): RuntimePort;
    onConnect: { addListener(cb: (port: RuntimePort) => void): void };
  };
  tabs: {
    captureTab(tabId: number, options?: CaptureOptions): Promise<string>;
  };
  devtools: {
    inspectedWindow: {
      tabId: number;
      eval(
        expression: string,
      ): Promise<[result: unknown, exceptionInfo?: EvalExceptionInfo]>;
    };
    network: {
      getHAR(): Promise<HarLog>;
      onRequestFinished: {
        addListener(cb: (entry: HarEntry) => void): void;
      };
      onNavigated: {
        addListener(cb: (url: string) => void): void;
      };
    };
    panels: {
      create(
        title: string,
        icon: string,
        page: string,
      ): Promise<unknown>;
    };
  };
}

declare const browser: Browser;

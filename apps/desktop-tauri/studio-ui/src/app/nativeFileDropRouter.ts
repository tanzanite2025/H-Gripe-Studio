import { listenFileDrop, type FileDropEvent } from "../bridge/files";

type Unlisten = () => void;
export type NativeFileDropListen = (
  callback: (event: FileDropEvent) => void,
) => Promise<Unlisten | null>;

export interface NativeFileDropContext {
  event: FileDropEvent;
  target: Element | null;
  cssPosition: { x: number; y: number };
}

export interface NativeFileDropConsumer {
  id: string;
  priority: number;
  claims: (context: NativeFileDropContext) => boolean;
  handle: (context: NativeFileDropContext) => void | Promise<void>;
}

export interface NativeFileDropRouter {
  register: (consumer: NativeFileDropConsumer) => () => void;
  route: (event: FileDropEvent) => boolean;
  retainListener: (listen?: NativeFileDropListen) => () => void;
}

export interface NativeFileDropRouterEnvironment {
  devicePixelRatio: () => number;
  elementFromPoint: (x: number, y: number) => Element | null;
}

function browserEnvironment(): NativeFileDropRouterEnvironment {
  return {
    devicePixelRatio: () => window.devicePixelRatio || 1,
    elementFromPoint: (x, y) => document.elementFromPoint(x, y),
  };
}

export function createNativeFileDropRouter(
  environment: NativeFileDropRouterEnvironment = browserEnvironment(),
): NativeFileDropRouter {
  let registrationOrder = 0;
  const consumers = new Map<number, NativeFileDropConsumer>();
  let listenerReferences = 0;
  let pendingListener: Promise<Unlisten | null> | null = null;
  let activeUnlisten: Unlisten | null = null;

  const warnHandlerFailure = (consumer: NativeFileDropConsumer, error: unknown) => {
    console.warn(`Native file drop consumer ${consumer.id} failed`, error);
  };

  const retainListener = (listen: NativeFileDropListen = listenFileDrop) => {
    listenerReferences += 1;
    if (!pendingListener && !activeUnlisten) {
      const pending = listen((event) => {
        router.route(event);
      });
      pendingListener = pending;
      void pending.then(
        (unlisten) => {
          if (pendingListener !== pending) {
            unlisten?.();
            return;
          }
          pendingListener = null;
          if (listenerReferences === 0) unlisten?.();
          else activeUnlisten = unlisten;
        },
        (error) => {
          if (pendingListener === pending) pendingListener = null;
          console.warn("Native file drop listener failed", error);
        },
      );
    }
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      listenerReferences = Math.max(0, listenerReferences - 1);
      if (listenerReferences !== 0 || !activeUnlisten) return;
      const unlisten = activeUnlisten;
      activeUnlisten = null;
      unlisten();
    };
  };

  const router: NativeFileDropRouter = {
    register: (consumer) => {
      registrationOrder += 1;
      const token = registrationOrder;
      consumers.set(token, consumer);
      return () => consumers.delete(token);
    },
    route: (event) => {
      const dpr = Math.max(1, environment.devicePixelRatio());
      const cssPosition = {
        x: event.position.x / dpr,
        y: event.position.y / dpr,
      };
      const context: NativeFileDropContext = {
        event,
        target: environment.elementFromPoint(cssPosition.x, cssPosition.y),
        cssPosition,
      };
      const match = [...consumers.entries()]
        .filter(([, consumer]) => consumer.claims(context))
        .sort(([leftOrder, left], [rightOrder, right]) =>
          right.priority - left.priority || rightOrder - leftOrder,
        )[0]?.[1];
      if (!match) return false;
      try {
        void Promise.resolve(match.handle(context)).catch((error) => {
          warnHandlerFailure(match, error);
        });
      } catch (error) {
        warnHandlerFailure(match, error);
      }
      return true;
    },
    retainListener,
  };
  return router;
}

export const nativeFileDropRouter = createNativeFileDropRouter();

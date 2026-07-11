// React binding for the production store: components inside the production
// drawer read state and dispatch actions against the store from this context
// instead of receiving every slice / action as a prop. The default value is
// the application-wide store, so the app needs no explicit provider; tests
// wrap components in `ProductionStoreProvider` with their own store.

import { createContext, useContext, type ReactNode } from "react";

import {
  productionStore,
  useProductionState,
  type ProductionState,
  type ProductionStore,
} from "./productionStore";

const ProductionStoreContext = createContext<ProductionStore>(productionStore);

export function ProductionStoreProvider({
  store,
  children,
}: {
  store: ProductionStore;
  children: ReactNode;
}) {
  return (
    <ProductionStoreContext.Provider value={store}>{children}</ProductionStoreContext.Provider>
  );
}

/** The production store for this subtree (the app-wide store by default). */
export function useProductionStoreFromContext(): ProductionStore {
  return useContext(ProductionStoreContext);
}

/** Subscribe to a slice of the contextual production store's state. */
export function useProductionStateFromContext<T>(select: (state: ProductionState) => T): T {
  const store = useContext(ProductionStoreContext);
  return useProductionState(select, store);
}

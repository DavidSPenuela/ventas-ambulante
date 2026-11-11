import { requireNativeModule } from 'expo';

const Native = requireNativeModule('WearBridge');

/** Envía la lista de productos activos (JSON) al reloj. */
export const sendProducts = (json: string): Promise<void> => Native.sendProducts(json);
/** Ventas hechas en el reloj que aún no se han subido (cada una es un JSON). */
export const getPendingSales = (): Promise<string[]> => Native.getPendingSales();
/** Confirma al reloj que esas ventas ya están en Supabase. */
export const ackSales = (ids: string[]): Promise<void> => Native.ackSales(ids);
/** Avisa cuando llega una venta nueva desde el reloj. */
export const addSalesListener = (cb: () => void) => Native.addListener('onSalesChanged', cb);

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, AppState, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { supabase } from './src/supabase';
import * as Wear from './modules/wear-bridge';

const C = { ink: '#1B1F2A', bg: '#F3F5F7', card: '#FFFFFF', mango: '#F5A524', green: '#1F8A5B', muted: '#6B7280', line: '#E3E7EC', red: '#C0392B' };
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

export default function App() {
  const [tab, setTab] = useState('resumen');
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [status, setStatus] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [editingId, setEditingId] = useState(null);

  const pushProducts = useCallback(async (list) => {
    try {
      const active = list.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, price: Number(p.price) }));
      await Wear.sendProducts(JSON.stringify(active));
    } catch (e) { setStatus('No se pudo enviar la lista al reloj: ' + (e.message || e)); }
  }, []);

  const loadProducts = useCallback(async () => {
    const { data, error } = await supabase.from('products').select('*').order('created_at');
    if (error) return setStatus('Error al cargar productos: ' + error.message);
    setProducts(data);
    pushProducts(data);
  }, [pushProducts]);

  const loadSales = useCallback(async () => {
    const { data, error } = await supabase.from('sales').select('*').gte('sold_at', startOfToday()).order('sold_at', { ascending: false });
    if (error) return setStatus('Error al cargar ventas: ' + error.message);
    setSales(data);
  }, []);

  // Reloj -> Supabase. Las ventas se borran del reloj solo después de guardarse.
  const syncFromWatch = useCallback(async () => {
    try {
      const raw = await Wear.getPendingSales();
      if (raw.length) {
        const rows = raw.map((r) => ({ ...JSON.parse(r), source: 'watch' }));
        const { error } = await supabase.from('sales').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
        if (error) throw error;
        await Wear.ackSales(rows.map((r) => r.id));
        setStatus(`${rows.length} venta(s) recibida(s) del reloj`);
      }
      await loadSales();
    } catch (e) { setStatus('Sincronización: ' + (e.message || e)); }
  }, [loadSales]);

  useEffect(() => {
    loadProducts().then(syncFromWatch);
    const sub = Wear.addSalesListener(() => syncFromWatch());
    const app = AppState.addEventListener('change', (s) => { if (s === 'active') syncFromWatch(); });
    return () => { sub?.remove?.(); app.remove(); };
  }, [loadProducts, syncFromWatch]);

  const saveProduct = async () => {
    const p = parseFloat(price.replace(',', '.'));
    if (!name.trim() || Number.isNaN(p) || p < 0) return Alert.alert('Revisa los datos', 'Escribe un nombre y un precio válido.');
    const body = { name: name.trim(), price: p };
    const { error } = editingId
      ? await supabase.from('products').update(body).eq('id', editingId)
      : await supabase.from('products').insert(body);
    if (error) return Alert.alert('No se guardó', error.message);
    setName(''); setPrice(''); setEditingId(null);
    loadProducts();
  };
  const toggleActive = async (p) => { await supabase.from('products').update({ active: !p.active }).eq('id', p.id); loadProducts(); };
  const editProduct = (p) => { setEditingId(p.id); setName(p.name); setPrice(String(p.price)); };
  const removeSale = (s) => Alert.alert('Eliminar venta', 'Se borra de la base de datos.', [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Eliminar', style: 'destructive', onPress: async () => { await supabase.from('sales').delete().eq('id', s.id); loadSales(); } },
  ]);

  const summary = useMemo(() => {
    const by = {};
    sales.forEach((s) => {
      const r = (by[s.product_id] ||= { units: 0, total: 0 });
      r.units += s.quantity; r.total += s.quantity * Number(s.unit_price);
    });
    const rows = Object.entries(by)
      .map(([id, v]) => ({ id, name: products.find((p) => p.id === id)?.name ?? 'Producto', ...v }))
      .sort((a, b) => b.units - a.units);
    return { rows, total: rows.reduce((a, r) => a + r.total, 0), units: rows.reduce((a, r) => a + r.units, 0), top: rows[0] };
  }, [sales, products]);
  const nameOf = (id) => products.find((p) => p.id === id)?.name ?? 'Producto';

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />
      <View style={s.tabs}>
        {[['resumen', 'Hoy'], ['productos', 'Productos']].map(([k, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && s.tabOn]}>
            <Text style={[s.tabTxt, tab === k && s.tabTxtOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {!!status && <Text style={s.status} onPress={() => setStatus('')}>{status}</Text>}

      {tab === 'resumen' ? (
        <ScrollView contentContainerStyle={s.pad}>
          <View style={s.hero}>
            <Text style={s.heroLabel}>Vendido hoy</Text>
            <Text style={s.heroNum}>{money(summary.total)}</Text>
            <Text style={s.heroSub}>{summary.units} {summary.units === 1 ? 'pieza' : 'piezas'}</Text>
            <Text style={s.heroSub}>{summary.top ? `Más vendido: ${summary.top.name} (${summary.top.units})` : 'Aún no hay ventas hoy'}</Text>
          </View>
          <Pressable style={s.btnGhost} onPress={() => { loadProducts(); syncFromWatch(); }}>
            <Text style={s.btnGhostTxt}>Actualizar y recibir del reloj</Text>
          </Pressable>
          <Text style={s.h2}>Por producto</Text>
          {summary.rows.length === 0 && <Text style={s.muted}>Toca un producto en el reloj para registrar la primera venta.</Text>}
          {summary.rows.map((r) => (
            <View key={r.id} style={s.row}>
              <Text style={s.rowMain}>{r.name}</Text>
              <Text style={s.rowSide}>{r.units} × · {money(r.total)}</Text>
            </View>
          ))}
          <Text style={s.h2}>Ventas de hoy</Text>
          {sales.map((x) => (
            <View key={x.id} style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowMain}>{nameOf(x.product_id)}</Text>
                <Text style={s.muted}>{hhmm(x.sold_at)} · {x.source === 'watch' ? 'reloj' : 'teléfono'}</Text>
              </View>
              <Text style={s.rowSide}>{money(x.quantity * x.unit_price)}</Text>
              <Pressable onPress={() => removeSale(x)} hitSlop={10}><Text style={s.del}>Eliminar</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          <Text style={s.h2}>{editingId ? 'Editar producto' : 'Nuevo producto'}</Text>
          <TextInput style={s.input} placeholder="Nombre" value={name} onChangeText={setName} />
          <TextInput style={s.input} placeholder="Precio" keyboardType="decimal-pad" value={price} onChangeText={setPrice} />
          <Pressable style={s.btn} onPress={saveProduct}><Text style={s.btnTxt}>{editingId ? 'Guardar cambios' : 'Agregar producto'}</Text></Pressable>
          {editingId && <Pressable style={s.btnGhost} onPress={() => { setEditingId(null); setName(''); setPrice(''); }}><Text style={s.btnGhostTxt}>Cancelar edición</Text></Pressable>}
          <Text style={s.h2}>Tu catálogo</Text>
          <Text style={s.muted}>Los productos activos aparecen como botones en el reloj.</Text>
          {products.map((p) => (
            <View key={p.id} style={[s.row, !p.active && { opacity: 0.5 }]}>
              <Pressable style={{ flex: 1 }} onPress={() => editProduct(p)}>
                <Text style={s.rowMain}>{p.name}</Text>
                <Text style={s.muted}>{money(p.price)} · toca para editar</Text>
              </Pressable>
              <Pressable onPress={() => toggleActive(p)} hitSlop={10}><Text style={s.del}>{p.active ? 'Desactivar' : 'Activar'}</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  tabs: { flexDirection: 'row', margin: 16, marginBottom: 4, backgroundColor: C.line, borderRadius: 12, padding: 4 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center' },
  tabOn: { backgroundColor: C.ink },
  tabTxt: { color: C.muted, fontWeight: '600', fontSize: 15 },
  tabTxtOn: { color: '#fff' },
  status: { marginHorizontal: 16, marginTop: 6, color: C.muted, fontSize: 13 },
  pad: { padding: 16, paddingBottom: 48 },
  hero: { backgroundColor: C.ink, borderRadius: 20, padding: 22, marginBottom: 12 },
  heroLabel: { color: '#AEB6C4', fontSize: 14 },
  heroNum: { color: C.mango, fontSize: 52, fontWeight: '800', marginVertical: 2 },
  heroSub: { color: '#fff', fontSize: 15, marginTop: 2 },
  h2: { fontSize: 18, fontWeight: '700', color: C.ink, marginTop: 22, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 8 },
  rowMain: { fontSize: 16, color: C.ink, fontWeight: '600' },
  rowSide: { fontSize: 15, color: C.green, fontWeight: '700' },
  muted: { color: C.muted, fontSize: 13 },
  del: { color: C.red, fontSize: 13, fontWeight: '600' },
  input: { backgroundColor: C.card, borderRadius: 12, padding: 14, fontSize: 16, marginBottom: 8, borderWidth: 1, borderColor: C.line },
  btn: { backgroundColor: C.mango, borderRadius: 12, padding: 15, alignItems: 'center', marginTop: 4 },
  btnTxt: { color: C.ink, fontWeight: '800', fontSize: 16 },
  btnGhost: { borderRadius: 12, padding: 13, alignItems: 'center', borderWidth: 1, borderColor: C.line, backgroundColor: C.card, marginTop: 6 },
  btnGhostTxt: { color: C.ink, fontWeight: '600' },
});

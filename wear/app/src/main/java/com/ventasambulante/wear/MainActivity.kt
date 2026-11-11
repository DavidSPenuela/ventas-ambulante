package com.ventasambulante.wear

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Calendar
import java.util.UUID

data class Product(val id: String, val name: String, val price: Double)
data class Sale(val id: String, val productId: String, val price: Double, val ts: Long)

fun parseProducts(json: String): List<Product> {
    val a = JSONArray(json)
    return (0 until a.length()).map {
        val o = a.getJSONObject(it)
        Product(o.getString("id"), o.getString("name"), o.getDouble("price"))
    }
}

/** Guarda en el reloj la lista de productos y las ventas de HOY (para mostrar totales aunque no haya conexión). */
class Store(ctx: Context) {
    private val sp = ctx.getSharedPreferences("ventas", Context.MODE_PRIVATE)

    fun productsJson(): String = sp.getString("products", "[]") ?: "[]"
    fun saveProducts(json: String) = sp.edit().putString("products", json).apply()

    private fun startOfDay(): Long = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    fun sales(): List<Sale> {
        val arr = JSONArray(sp.getString("sales", "[]"))
        val start = startOfDay()
        val out = mutableListOf<Sale>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val s = Sale(o.getString("id"), o.getString("pid"), o.getDouble("price"), o.getLong("ts"))
            if (s.ts >= start) out.add(s)
        }
        return out
    }

    fun saveSales(list: List<Sale>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("id", it.id).put("pid", it.productId).put("price", it.price).put("ts", it.ts)) }
        sp.edit().putString("sales", arr.toString()).apply()
    }
}

class MainActivity : ComponentActivity(), DataClient.OnDataChangedListener {
    private lateinit var store: Store
    private val dataClient by lazy { Wearable.getDataClient(this) }
    private val products = mutableStateListOf<Product>()
    private val sales = mutableStateListOf<Sale>()
    private var message by mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        runCatching { products.addAll(parseProducts(store.productsJson())) }
        sales.addAll(store.sales())
        setContent { Screen() }
    }

    override fun onResume() {
        super.onResume()
        dataClient.addListener(this)
        refreshProducts()
    }

    override fun onPause() {
        super.onPause()
        dataClient.removeListener(this)
    }

    // Llega una lista nueva de productos desde el teléfono
    override fun onDataChanged(events: DataEventBuffer) {
        for (e in events) {
            if (e.type == DataEvent.TYPE_CHANGED && e.dataItem.uri.path == "/products") {
                applyProducts(DataMapItem.fromDataItem(e.dataItem).dataMap.getString("json"))
            }
        }
    }

    private fun uriOf(path: String): Uri = Uri.Builder().scheme(PutDataRequest.WEAR_URI_SCHEME).path(path).build()

    private fun refreshProducts() {
        dataClient.getDataItems(uriOf("/products"), DataClient.FILTER_PREFIX).addOnSuccessListener { buf ->
            for (item in buf) applyProducts(DataMapItem.fromDataItem(item).dataMap.getString("json"))
            buf.release()
        }
    }

    private fun applyProducts(json: String?) {
        if (json == null) return
        runCatching {
            val list = parseProducts(json)
            store.saveProducts(json)
            products.clear(); products.addAll(list)
        }
    }

    private fun sell(p: Product) {
        val sale = Sale(UUID.randomUUID().toString(), p.id, p.price, System.currentTimeMillis())
        sales.add(sale); store.saveSales(sales.toList()); message = ""
        val json = JSONObject()
            .put("id", sale.id).put("product_id", p.id).put("quantity", 1)
            .put("unit_price", p.price).put("sold_at", Instant.ofEpochMilli(sale.ts).toString())
            .toString()
        // Se encola y llega al teléfono cuando haya conexión; el teléfono lo borra al guardarlo en Supabase
        val req = PutDataMapRequest.create("/sale/${sale.id}").apply { dataMap.putString("json", json) }
            .asPutDataRequest().setUrgent()
        dataClient.putDataItem(req)
    }

    private fun undoLast() {
        val last = sales.lastOrNull() ?: return
        dataClient.getDataItems(uriOf("/sale"), DataClient.FILTER_PREFIX).addOnSuccessListener { buf ->
            var pending = false
            for (item in buf) {
                if (item.uri.lastPathSegment == last.id) { dataClient.deleteDataItems(item.uri); pending = true }
            }
            buf.release()
            if (pending) {
                sales.removeAll { it.id == last.id }; store.saveSales(sales.toList()); message = "Venta deshecha"
            } else {
                message = "Ya llegó al teléfono: bórrala allá"
            }
        }
    }

    @Composable
    private fun Screen() {
        val haptic = LocalHapticFeedback.current
        val total = sales.sumOf { it.price }
        MaterialTheme {
            Scaffold(timeText = { TimeText() }, vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) }) {
                ScalingLazyColumn(modifier = Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
                    item { Text("Hoy", style = MaterialTheme.typography.caption1) }
                    item { Text("$" + "%.2f".format(total), style = MaterialTheme.typography.title1) }
                    item { Text("${sales.size} ventas", style = MaterialTheme.typography.caption2) }
                    if (products.isEmpty()) {
                        item { Text("Agrega productos en el teléfono", textAlign = TextAlign.Center, style = MaterialTheme.typography.body2) }
                    }
                    items(products.size) { i ->
                        val p = products[i]
                        val n = sales.count { it.productId == p.id }
                        Chip(
                            onClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); sell(p) },
                            label = { Text(p.name) },
                            secondaryLabel = { Text("$" + "%.0f".format(p.price) + "  ·  $n") },
                            colors = ChipDefaults.primaryChipColors()
                        )
                    }
                    item {
                        Chip(
                            onClick = { undoLast() },
                            label = { Text("Deshacer última") },
                            colors = ChipDefaults.secondaryChipColors()
                        )
                    }
                    if (message.isNotEmpty()) {
                        item { Text(message, textAlign = TextAlign.Center, style = MaterialTheme.typography.caption2) }
                    }
                }
            }
        }
    }
}

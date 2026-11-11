package expo.modules.wearbridge

import android.net.Uri
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.PutDataRequest
import com.google.android.gms.wearable.Wearable
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WearBridgeModule : Module() {
  private val ctx get() = requireNotNull(appContext.reactContext)
  private val data by lazy { Wearable.getDataClient(ctx) }
  private var listener: DataClient.OnDataChangedListener? = null

  private fun salesUri(): Uri =
    Uri.Builder().scheme(PutDataRequest.WEAR_URI_SCHEME).path("/sale").build()

  override fun definition() = ModuleDefinition {
    Name("WearBridge")
    Events("onSalesChanged")

    OnStartObserving {
      val l = DataClient.OnDataChangedListener { events ->
        val hit = events.any {
          it.type == DataEvent.TYPE_CHANGED && it.dataItem.uri.path?.startsWith("/sale/") == true
        }
        if (hit) sendEvent("onSalesChanged", mapOf("changed" to true))
      }
      listener = l
      data.addListener(l)
    }

    OnStopObserving {
      listener?.let { data.removeListener(it) }
      listener = null
    }

    // Teléfono -> reloj: lista de productos como DataItem (se sincroniza cuando hay conexión)
    AsyncFunction("sendProducts") { json: String, promise: Promise ->
      val req = PutDataMapRequest.create("/products").apply {
        dataMap.putString("json", json)
        dataMap.putLong("ts", System.currentTimeMillis()) // fuerza el evento aunque el JSON sea igual
      }.asPutDataRequest().setUrgent()
      data.putDataItem(req)
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { promise.reject("E_WEAR", it.message, it) }
    }

    // Reloj -> teléfono: ventas pendientes (DataItems /sale/<id>)
    AsyncFunction("getPendingSales") { promise: Promise ->
      data.getDataItems(salesUri(), DataClient.FILTER_PREFIX)
        .addOnSuccessListener { buf ->
          val out = ArrayList<String>()
          for (item in buf) {
            DataMapItem.fromDataItem(item).dataMap.getString("json")?.let { out.add(it) }
          }
          buf.release()
          promise.resolve(out)
        }
        .addOnFailureListener { promise.reject("E_WEAR", it.message, it) }
    }

    // Ya se subieron a Supabase: se borran los DataItems (el reloj lo nota)
    AsyncFunction("ackSales") { ids: List<String>, promise: Promise ->
      val wanted = ids.toSet()
      data.getDataItems(salesUri(), DataClient.FILTER_PREFIX)
        .addOnSuccessListener { buf ->
          val tasks = ArrayList<Task<Int>>()
          for (item in buf) {
            if (wanted.contains(item.uri.lastPathSegment)) tasks.add(data.deleteDataItems(item.uri))
          }
          buf.release()
          Tasks.whenAll(tasks)
            .addOnSuccessListener { promise.resolve(null) }
            .addOnFailureListener { promise.reject("E_WEAR", it.message, it) }
        }
        .addOnFailureListener { promise.reject("E_WEAR", it.message, it) }
    }
  }
}

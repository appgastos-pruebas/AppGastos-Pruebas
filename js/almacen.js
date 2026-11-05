window.appGastos = window.appGastos || {};

(function () {
    const NOMBRE_BD = "AppGastos";
    const VERSION_BD = 3;
    const TRANSACCIONES = "transacciones";
    const CUENTAS_ORIGEN = "cuentasOrigen";
    const CUENTAS_GASTO = "cuentasGasto";
    const CUENTAS_INGRESO = "cuentasIngreso";
    const AJUSTES = "ajustes";
    const TESTAMENTO = "testamento";
    const SEGURIDAD_TESTAMENTO = "seguridadTestamento";
    const INDICE_FECHA = "fecha";

    let conexion = null;

    // Versión 1 a 2: llegan los ingresos. Las transacciones anteriores eran gastos, y su
    // cuentaGasto pasa a llamarse cuentaDestino.
    function migrarTransaccionesAVersion2(transaccion) {
        const solicitud = transaccion.objectStore(TRANSACCIONES).openCursor();
        solicitud.onsuccess = () => {
            const cursor = solicitud.result;
            if (!cursor) {
                return;
            }
            const { cuentaGasto, ...resto } = cursor.value;
            cursor.update({
                ...resto,
                tipo: resto.tipo ?? "Gasto",
                cuentaDestino: resto.cuentaDestino ?? cuentaGasto ?? "",
            });
            cursor.continue();
        };
    }

    function abrir() {
        if (conexion) {
            return conexion;
        }

        conexion = new Promise((resolver, rechazar) => {
            const solicitud = indexedDB.open(NOMBRE_BD, VERSION_BD);

            // Solo corre al crear la base de datos o al subir VERSION_BD. Si algo falla, IndexedDB
            // deshace todo y los datos quedan como estaban.
            solicitud.onupgradeneeded = evento => {
                const bd = solicitud.result;
                if (evento.oldVersion < 1) {
                    const transacciones = bd.createObjectStore(TRANSACCIONES, { keyPath: "id" });
                    transacciones.createIndex(INDICE_FECHA, "fecha");
                    bd.createObjectStore(CUENTAS_ORIGEN, { keyPath: "nombre" });
                    bd.createObjectStore(CUENTAS_GASTO, { keyPath: "nombre" });
                    bd.createObjectStore(AJUSTES, { keyPath: "clave" });
                }
                if (evento.oldVersion < 2) {
                    bd.createObjectStore(CUENTAS_INGRESO, { keyPath: "nombre" });
                    migrarTransaccionesAVersion2(solicitud.transaction);
                }
                // Almacenes aparte: los borrados de transacciones no los incluyen. No cambia datos existentes.
                if (evento.oldVersion < 3) {
                    bd.createObjectStore(TESTAMENTO, { keyPath: "clave" });
                    bd.createObjectStore(SEGURIDAD_TESTAMENTO, { keyPath: "clave" });
                }
            };

            solicitud.onsuccess = () => {
                const bd = solicitud.result;
                // Si otra pestaña trae una versión nueva, se cierra para no bloquearla.
                bd.onversionchange = () => {
                    bd.close();
                    conexion = null;
                };
                resolver(bd);
            };

            solicitud.onerror = () => {
                conexion = null;
                rechazar(solicitud.error);
            };

            solicitud.onblocked = () => {
                conexion = null;
                rechazar(new Error("La base de datos está abierta en otra ventana."));
            };
        });

        return conexion;
    }

    // Resuelve al completarse la transacción, no al terminar cada operación: solo entonces
    // el dato está guardado. Si algo falla, IndexedDB deshace toda la transacción.
    async function ejecutar(almacenes, modo, trabajo) {
        const bd = await abrir();
        return new Promise((resolver, rechazar) => {
            const transaccion = bd.transaction(almacenes, modo);
            const salida = { valor: null };
            transaccion.oncomplete = () => resolver(salida.valor);
            let fallo = null;
            transaccion.onerror = () => rechazar(fallo ?? transaccion.error);
            transaccion.onabort = () => rechazar(fallo ?? transaccion.error);
            try {
                trabajo(transaccion, salida);
            } catch (error) {
                // Sin esto, lo ya hecho se confirmaría: un clear seguido de un error vaciaría el almacén.
                fallo = error;
                transaccion.abort();
            }
        });
    }

    function rangoDeFechas(desde, hasta) {
        if (desde && hasta) {
            return IDBKeyRange.bound(desde, hasta);
        }
        if (desde) {
            return IDBKeyRange.lowerBound(desde);
        }
        return hasta ? IDBKeyRange.upperBound(hasta) : null;
    }

    function esRangoInvertido(desde, hasta) {
        return desde && hasta && desde > hasta;
    }

    function listarTodo(almacen) {
        return ejecutar(almacen, "readonly", (transaccion, salida) => {
            const solicitud = transaccion.objectStore(almacen).getAll();
            solicitud.onsuccess = () => salida.valor = solicitud.result;
        });
    }

    function reemplazarAlmacen(transaccion, almacen, elementos) {
        const destino = transaccion.objectStore(almacen);
        destino.clear();
        elementos.forEach(elemento => destino.put(elemento));
    }

    // TODOS es lo que copia y restaura el respaldo: un almacén nuevo debe añadirse aquí.
    const TODOS = [TRANSACCIONES, CUENTAS_ORIGEN, CUENTAS_GASTO, CUENTAS_INGRESO, AJUSTES, TESTAMENTO, SEGURIDAD_TESTAMENTO];
    window.appGastos.baseDatos = { ejecutar, TESTAMENTO, SEGURIDAD_TESTAMENTO, AJUSTES, TODOS };

    window.appGastos.almacen = {
        guardarTransaccion: transaccionNueva => ejecutar(TRANSACCIONES, "readwrite", transaccion => {
            transaccion.objectStore(TRANSACCIONES).put(transaccionNueva);
        }),

        obtenerTransaccion: id => ejecutar(TRANSACCIONES, "readonly", (transaccion, salida) => {
            const solicitud = transaccion.objectStore(TRANSACCIONES).get(id);
            solicitud.onsuccess = () => salida.valor = solicitud.result ?? null;
        }),

        // Las fechas son texto aaaa-mm-dd, que se ordena igual que las fechas.
        listarTransacciones: async (desde, hasta) => {
            if (esRangoInvertido(desde, hasta)) {
                return [];
            }
            return ejecutar(TRANSACCIONES, "readonly", (transaccion, salida) => {
                const indice = transaccion.objectStore(TRANSACCIONES).index(INDICE_FECHA);
                const solicitud = indice.getAll(rangoDeFechas(desde, hasta));
                solicitud.onsuccess = () => salida.valor = solicitud.result;
            });
        },

        borrarTransaccion: id => ejecutar(TRANSACCIONES, "readwrite", transaccion => {
            transaccion.objectStore(TRANSACCIONES).delete(id);
        }),

        // La transacción solo incluye el almacén de transacciones: no puede tocar cuentas ni ajustes.
        borrarTransaccionesPorRango: async (desde, hasta) => {
            if (esRangoInvertido(desde, hasta)) {
                return 0;
            }
            return ejecutar(TRANSACCIONES, "readwrite", (transaccion, salida) => {
                salida.valor = 0;
                const indice = transaccion.objectStore(TRANSACCIONES).index(INDICE_FECHA);
                const solicitud = indice.openCursor(rangoDeFechas(desde, hasta));
                solicitud.onsuccess = () => {
                    const cursor = solicitud.result;
                    if (cursor) {
                        cursor.delete();
                        salida.valor++;
                        cursor.continue();
                    }
                };
            });
        },

        // Contar y vaciar van en la misma transacción: o se borran todas, o ninguna.
        // Solo incluye el almacén de transacciones: no puede tocar cuentas ni ajustes.
        borrarTodasLasTransacciones: () => ejecutar(TRANSACCIONES, "readwrite", (transaccion, salida) => {
            const almacen = transaccion.objectStore(TRANSACCIONES);
            const cantidad = almacen.count();
            cantidad.onsuccess = () => salida.valor = cantidad.result;
            almacen.clear();
        }),

        listarCuentasOrigen: () => listarTodo(CUENTAS_ORIGEN),
        listarCuentasGasto: () => listarTodo(CUENTAS_GASTO),
        listarCuentasIngreso: () => listarTodo(CUENTAS_INGRESO),

        reemplazarCatalogo: (cuentasOrigen, cuentasGasto, cuentasIngreso) => ejecutar([CUENTAS_ORIGEN, CUENTAS_GASTO, CUENTAS_INGRESO], "readwrite", transaccion => {
            reemplazarAlmacen(transaccion, CUENTAS_ORIGEN, cuentasOrigen);
            reemplazarAlmacen(transaccion, CUENTAS_GASTO, cuentasGasto);
            reemplazarAlmacen(transaccion, CUENTAS_INGRESO, cuentasIngreso);
        }),

        obtenerAjuste: clave => ejecutar(AJUSTES, "readonly", (transaccion, salida) => {
            const solicitud = transaccion.objectStore(AJUSTES).get(clave);
            solicitud.onsuccess = () => salida.valor = solicitud.result?.valor ?? null;
        }),

        guardarAjuste: (clave, valor) => ejecutar(AJUSTES, "readwrite", transaccion => {
            transaccion.objectStore(AJUSTES).put({ clave, valor });
        }),

        // Pide al navegador que no borre los datos cuando falte espacio. Puede responder que no.
        pedirPersistencia: async () => {
            if (!navigator.storage || !navigator.storage.persist) {
                return false;
            }
            return navigator.storage.persist();
        },
    };
})();

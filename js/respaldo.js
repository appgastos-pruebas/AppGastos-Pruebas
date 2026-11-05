window.appGastos = window.appGastos || {};

// El respaldo: copia todos los almacenes tal como están guardados y los cifra con una contraseña.
// Lo hace el navegador (crypto.subtle). La contraseña nunca se guarda, ni en el archivo ni en el teléfono.
// El testamento ya está cifrado con su PIN y viaja así, cifrado otra vez con la contraseña.
(function () {
    const { ejecutar, AJUSTES, TODOS } = window.appGastos.baseDatos;
    const FORMATO_ARCHIVO = "AppGastos-respaldo";
    const FORMATO_CONTENIDO = "AppGastos-respaldo-contenido";
    const VERSION = 1;
    const ITERACIONES = 600000;
    // No viaja en el respaldo: es un aviso de este teléfono.
    const CLAVE_RECORDATORIO = "recordarBorrarRespaldo";

    function aBase64(bytes) {
        let texto = "";
        // Por partes: con millones de bytes, String.fromCharCode(...todos) falla.
        for (let i = 0; i < bytes.length; i += 0x8000) {
            texto += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(texto);
    }

    function deBase64(texto) {
        const binario = atob(texto);
        const bytes = new Uint8Array(binario.length);
        for (let i = 0; i < binario.length; i++) {
            bytes[i] = binario.charCodeAt(i);
        }
        return bytes;
    }

    // JSON no guarda bytes. La sal, el hash y el testamento cifrado se escriben en base64 y se marcan,
    // para devolverlos exactamente al mismo tipo al restaurar.
    function codificar(valor) {
        if (valor instanceof Uint8Array) {
            return { $bytes: aBase64(valor) };
        }
        if (valor instanceof ArrayBuffer) {
            return { $buffer: aBase64(new Uint8Array(valor)) };
        }
        if (Array.isArray(valor)) {
            return valor.map(codificar);
        }
        if (valor && typeof valor === "object") {
            return Object.fromEntries(Object.entries(valor).map(([clave, v]) => [clave, codificar(v)]));
        }
        return valor;
    }

    function decodificar(valor) {
        if (Array.isArray(valor)) {
            return valor.map(decodificar);
        }
        if (valor && typeof valor === "object") {
            const claves = Object.keys(valor);
            if (claves.length === 1 && typeof valor.$bytes === "string") {
                return deBase64(valor.$bytes);
            }
            if (claves.length === 1 && typeof valor.$buffer === "string") {
                return deBase64(valor.$buffer).buffer;
            }
            return Object.fromEntries(Object.entries(valor).map(([clave, v]) => [clave, decodificar(v)]));
        }
        return valor;
    }

    async function claveDesde(contrasena, sal, iteraciones) {
        const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(contrasena), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }

    // La hora del teléfono, para mostrar cuándo se creó el respaldo.
    function ahoraLocal() {
        const d = new Date();
        const dos = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
    }

    // Una sola transacción de lectura: todos los almacenes salen del mismo momento.
    function leerTodo() {
        return ejecutar(TODOS, "readonly", (transaccion, salida) => {
            salida.valor = {};
            for (const almacen of TODOS) {
                const solicitud = transaccion.objectStore(almacen).getAll();
                solicitud.onsuccess = () => salida.valor[almacen] = solicitud.result;
            }
        });
    }

    window.appGastos.respaldo = {
        crear: async contrasena => {
            const almacenes = await leerTodo();
            almacenes[AJUSTES] = almacenes[AJUSTES].filter(ajuste => ajuste.clave !== CLAVE_RECORDATORIO);
            const contenido = JSON.stringify({ formato: FORMATO_CONTENIDO, version: VERSION, creado: ahoraLocal(), almacenes: codificar(almacenes) });

            const sal = crypto.getRandomValues(new Uint8Array(16));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const clave = await claveDesde(contrasena, sal, ITERACIONES);
            const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, clave, new TextEncoder().encode(contenido));
            return JSON.stringify({
                formato: FORMATO_ARCHIVO,
                version: VERSION,
                cifrado: { algoritmo: "AES-GCM", derivacion: "PBKDF2-SHA256", iteraciones: ITERACIONES, sal: aBase64(sal), iv: aBase64(iv) },
                datos: aBase64(new Uint8Array(cifrado)),
            });
        },

        // Devuelve { estado, contenido }. estado: "ok", "no-es-respaldo", "version-nueva" o "contrasena".
        abrir: async (textoArchivo, contrasena) => {
            let archivo;
            try {
                archivo = JSON.parse(textoArchivo);
            } catch {
                return { estado: "no-es-respaldo", contenido: null };
            }
            if (archivo?.formato !== FORMATO_ARCHIVO) {
                return { estado: "no-es-respaldo", contenido: null };
            }
            if (archivo.version > VERSION) {
                return { estado: "version-nueva", contenido: null };
            }
            const c = archivo.cifrado;
            if (archivo.version !== VERSION || typeof archivo.datos !== "string" || typeof c?.sal !== "string" || typeof c?.iv !== "string" || !Number.isInteger(c?.iteraciones) || c.iteraciones < 1) {
                return { estado: "no-es-respaldo", contenido: null };
            }

            // AES-GCM detecta tanto una contraseña equivocada como un archivo alterado: no se pueden distinguir.
            try {
                const clave = await claveDesde(contrasena, deBase64(c.sal), c.iteraciones);
                const texto = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deBase64(c.iv) }, clave, deBase64(archivo.datos));
                return { estado: "ok", contenido: new TextDecoder().decode(texto) };
            } catch {
                return { estado: "contrasena", contenido: null };
            }
        },

        // Cuántos registros hay ahora en cada almacén, para avisar antes de reemplazarlos.
        // El recordatorio no cuenta como dato.
        contar: () => ejecutar(TODOS, "readonly", (transaccion, salida) => {
            salida.valor = {};
            for (const almacen of TODOS) {
                const solicitud = transaccion.objectStore(almacen).getAllKeys();
                solicitud.onsuccess = () => salida.valor[almacen] = solicitud.result.filter(clave => !(almacen === AJUSTES && clave === CLAVE_RECORDATORIO)).length;
            }
        }),

        // Reemplaza todo en una sola transacción: si algo falla, el teléfono queda como estaba.
        // El contenido ya pasó por la revisión de RevisorRespaldo.
        restaurar: contenido => {
            const almacenes = decodificar(JSON.parse(contenido).almacenes);
            return ejecutar(TODOS, "readwrite", transaccion => {
                for (const almacen of TODOS) {
                    const destino = transaccion.objectStore(almacen);
                    destino.clear();
                    almacenes[almacen].forEach(registro => destino.put(registro));
                }
                transaccion.objectStore(AJUSTES).put({ clave: CLAVE_RECORDATORIO, valor: true });
            });
        },
    };
})();

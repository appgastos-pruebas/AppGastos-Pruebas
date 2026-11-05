window.appGastos = window.appGastos || {};

// El PIN y el cifrado del testamento. Lo hace el navegador (crypto.subtle), que solo funciona en
// HTTPS: en GitHub Pages siempre lo es. Un PIN de 4 dígitos tiene 10,000 combinaciones: esto evita que
// alguien lea el testamento fácilmente, pero no resiste a quien saque los datos y las pruebe todas.
(function () {
    const { ejecutar, TESTAMENTO, SEGURIDAD_TESTAMENTO } = window.appGastos.baseDatos;
    const CLAVE_PIN = "pin";
    const CLAVE_CONTENIDO = "actual";
    const ITERACIONES = 600000;
    const INTENTOS_ANTES_DE_ESPERAR = 5;
    const ESPERA_MILISEGUNDOS = 30000;

    // Solo existe mientras el testamento está abierto, solo en memoria, y no se puede extraer.
    let claveDeCifrado = null;
    let pantalla = null;
    let eligiendoArchivo = false;

    // De una sola derivación salen dos cosas: una se guarda para comprobar el PIN, y la otra es la
    // clave de cifrado, que nunca se guarda. Conocer la primera no revela la segunda.
    async function derivar(pin, sal, iteraciones) {
        const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
        const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteraciones }, base, 512));
        const hash = bits.slice(0, 32);
        const clave = await crypto.subtle.importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
        bits.fill(0);
        return { hash, clave };
    }

    function leerRegistro(almacen, clave) {
        return ejecutar(almacen, "readonly", (transaccion, salida) => {
            const solicitud = transaccion.objectStore(almacen).get(clave);
            solicitud.onsuccess = () => salida.valor = solicitud.result ?? null;
        });
    }

    function guardarRegistro(almacen, registro) {
        return ejecutar(almacen, "readwrite", transaccion => {
            transaccion.objectStore(almacen).put(registro);
        });
    }

    function sonIguales(a, b) {
        return a.length === b.length && a.every((valor, i) => valor === b[i]);
    }

    function segundosDeEspera(seguridad) {
        return Math.max(0, Math.ceil(((seguridad?.bloqueadoHasta ?? 0) - Date.now()) / 1000));
    }

    function alCambiarVisibilidad() {
        if (document.visibilityState === "visible") {
            // Si se canceló el selector sin escoger nada, la protección vuelve poco después.
            setTimeout(() => eligiendoArchivo = false, 3000);
            return;
        }
        // Abrir el selector de archivos también envía la app a segundo plano, y eso no debe bloquearla.
        if (!eligiendoArchivo) {
            claveDeCifrado = null;
            pantalla?.invokeMethodAsync("AlOcultarse");
        }
    }

    function alTocar(evento) {
        if (evento.target.closest?.("[data-elige-archivo]")) {
            eligiendoArchivo = true;
        }
    }

    function alTerminarDeElegir() {
        eligiendoArchivo = false;
    }

    window.appGastos.testamento = {
        estado: async () => {
            const seguridad = await leerRegistro(SEGURIDAD_TESTAMENTO, CLAVE_PIN);
            const contenido = await leerRegistro(TESTAMENTO, CLAVE_CONTENIDO);
            return { hayPin: !!seguridad, hayTestamento: !!contenido, esperaSegundos: segundosDeEspera(seguridad) };
        },

        crearPin: async pin => {
            // Un PIN existente solo se reemplaza pasando por "Olvidé el PIN", que borra el testamento.
            if (await leerRegistro(SEGURIDAD_TESTAMENTO, CLAVE_PIN)) {
                throw new Error("Ya hay un PIN.");
            }
            const sal = crypto.getRandomValues(new Uint8Array(16));
            const { hash, clave } = await derivar(pin, sal, ITERACIONES);
            await guardarRegistro(SEGURIDAD_TESTAMENTO, { clave: CLAVE_PIN, sal, hash, iteraciones: ITERACIONES, intentos: 0, bloqueadoHasta: 0 });
            claveDeCifrado = clave;
        },

        desbloquear: async pin => {
            const seguridad = await leerRegistro(SEGURIDAD_TESTAMENTO, CLAVE_PIN);
            if (!seguridad) {
                throw new Error("No hay PIN.");
            }

            const espera = segundosDeEspera(seguridad);
            if (espera > 0) {
                return { correcto: false, intentosRestantes: 0, esperaSegundos: espera };
            }

            const { hash, clave } = await derivar(pin, seguridad.sal, seguridad.iteraciones);
            if (sonIguales(hash, seguridad.hash)) {
                await guardarRegistro(SEGURIDAD_TESTAMENTO, { ...seguridad, intentos: 0, bloqueadoHasta: 0 });
                claveDeCifrado = clave;
                return { correcto: true, intentosRestantes: INTENTOS_ANTES_DE_ESPERAR, esperaSegundos: 0 };
            }

            // Los intentos se guardan: cerrar y abrir la app no los reinicia.
            const intentos = seguridad.intentos + 1;
            const agotados = intentos >= INTENTOS_ANTES_DE_ESPERAR;
            await guardarRegistro(SEGURIDAD_TESTAMENTO, {
                ...seguridad,
                intentos: agotados ? 0 : intentos,
                bloqueadoHasta: agotados ? Date.now() + ESPERA_MILISEGUNDOS : 0,
            });
            return {
                correcto: false,
                intentosRestantes: agotados ? 0 : INTENTOS_ANTES_DE_ESPERAR - intentos,
                esperaSegundos: agotados ? ESPERA_MILISEGUNDOS / 1000 : 0,
            };
        },

        leer: async () => {
            if (!claveDeCifrado) {
                throw new Error("El testamento está bloqueado.");
            }
            const contenido = await leerRegistro(TESTAMENTO, CLAVE_CONTENIDO);
            if (!contenido) {
                return null;
            }
            const texto = await crypto.subtle.decrypt({ name: "AES-GCM", iv: contenido.iv }, claveDeCifrado, contenido.cifrado);
            return new TextDecoder().decode(texto);
        },

        guardar: async json => {
            if (!claveDeCifrado) {
                throw new Error("El testamento está bloqueado.");
            }
            // AES-GCM exige un valor nuevo cada vez que se cifra con la misma clave.
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, claveDeCifrado, new TextEncoder().encode(json));
            await guardarRegistro(TESTAMENTO, { clave: CLAVE_CONTENIDO, iv, cifrado });
        },

        bloquear: () => {
            claveDeCifrado = null;
        },

        // Solo incluye estos dos almacenes: no puede tocar transacciones, cuentas ni el correo.
        borrarTodo: async () => {
            await ejecutar([TESTAMENTO, SEGURIDAD_TESTAMENTO], "readwrite", transaccion => {
                transaccion.objectStore(TESTAMENTO).clear();
                transaccion.objectStore(SEGURIDAD_TESTAMENTO).clear();
            });
            claveDeCifrado = null;
        },

        vigilar: referencia => {
            pantalla = referencia;
            eligiendoArchivo = false;
            document.addEventListener("visibilitychange", alCambiarVisibilidad);
            document.addEventListener("click", alTocar, true);
            document.addEventListener("change", alTerminarDeElegir, true);
            document.addEventListener("cancel", alTerminarDeElegir, true);
        },

        dejarDeVigilar: () => {
            pantalla = null;
            claveDeCifrado = null;
            document.removeEventListener("visibilitychange", alCambiarVisibilidad);
            document.removeEventListener("click", alTocar, true);
            document.removeEventListener("change", alTerminarDeElegir, true);
            document.removeEventListener("cancel", alTerminarDeElegir, true);
        },
    };
})();

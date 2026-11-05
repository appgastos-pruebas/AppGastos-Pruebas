window.appGastos = window.appGastos || {};

// Devuelve "compartido", "cancelado", "guardado" o "guardado: <motivo>" si compartir falló.
window.appGastos.compartirOGuardar = async function (nombre, tipo, contenido) {
    const archivo = new File([contenido], nombre, { type: tipo });
    let motivo = "";

    // canShare no sirve para saber si se aceptará el archivo: Chrome para Android devuelve true
    // con un .xlsx y luego share lo rechaza. Por eso se intenta y se reacciona al error.
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
        try {
            // Solo se envía el archivo: añadir título o texto puede hacer que algunas apps lo ignoren.
            await navigator.share({ files: [archivo] });
            return "compartido";
        } catch (error) {
            if (error.name === "AbortError") {
                return "cancelado";
            }
            motivo = `: ${error.name}: ${error.message}`;
        }
    }

    guardarArchivo(archivo);
    return `guardado${motivo}`;
};

window.appGastos.copiarTexto = async function (texto) {
    try {
        await navigator.clipboard.writeText(texto);
        return true;
    } catch {
        return false;
    }
};

function guardarArchivo(archivo) {
    const enlace = document.createElement("a");
    enlace.href = URL.createObjectURL(archivo);
    enlace.download = archivo.name;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    // Se libera más tarde: hacerlo enseguida podría cancelar la descarga en algunos navegadores.
    setTimeout(() => URL.revokeObjectURL(enlace.href), 60000);
}

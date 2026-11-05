// Estilo cajero: cada dígito entra por la derecha y borrar quita el último.
// Para eso el cursor debe estar siempre al final, aunque se toque en medio del número.
(() => {
    function cursorAlFinal() {
        const campo = document.activeElement;
        if (!campo || !campo.hasAttribute("data-cajero")) {
            return;
        }

        const fin = campo.value.length;
        if (campo.selectionStart !== fin || campo.selectionEnd !== fin) {
            campo.setSelectionRange(fin, fin);
        }
    }

    document.addEventListener("selectionchange", cursorAlFinal);
    document.addEventListener("focusin", cursorAlFinal);
    document.addEventListener("click", cursorAlFinal);
})();

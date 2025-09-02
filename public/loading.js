// Inicia o processamento em background
document.addEventListener('DOMContentLoaded', function() {
    const urlParams = new URLSearchParams(window.location.search);
    const trackerId = window.location.pathname.split('/').pop();
    
    // Faz a requisição para processar em background
    fetch(`/c/${trackerId}/process?${urlParams.toString()}`, {
        method: 'GET',
        headers: {
            'X-Background-Process': 'true'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.redirect) {
            window.location.href = data.redirect;
        }
    })
    .catch(error => {
        console.error('Erro:', error);
        // Fallback - redireciona para WhatsApp genérico após 3 segundos
        setTimeout(() => {
            window.location.href = 'https://wa.me/';
        }, 3000);
    });
});

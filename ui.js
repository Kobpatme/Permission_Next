    // ===== CLEAN UX: MODAL + SIDEBAR =====
(function(){
  const sidebar  = document.getElementById('sidebar');
  const sideBtn  = document.getElementById('building-toggle');
  const modal    = document.getElementById('detail-drawer');
  const overlay  = document.getElementById('drawer-overlay');
  const closeBtn = document.getElementById('drawer-close');

  // --- MODAL open/close ---
  function openModal(){
    overlay.classList.add('open');
    requestAnimationFrame(()=>{
      modal.classList.add('open');
      openDialogAccessibility(modal, closeBtn);
    });
    document.addEventListener('keydown', onEsc);
  }
  function closeModal(){
    modal.classList.remove('open');
    overlay.classList.remove('open');
    closeDialogAccessibility(modal);
    selectedId = null;
    document.querySelectorAll('.list-item').forEach(el=>el.classList.remove('selected'));
    allMarkers.forEach(({marker,data:d})=>marker.setIcon(makeIcon(statusColor(d.status),false)));
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc(e){ if(e.key==='Escape') closeModal(); }

  // Wrap openDrawer to also show modal
  const _origOpen = window.openDrawer;
  window.openDrawer = function(r){
    _origOpen(r);
    openModal();
  };

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', closeModal);

  // --- SIDEBAR toggle ---
  sideBtn.addEventListener('click', (e)=>{
    e.stopPropagation();
    const isOpen = sidebar.classList.toggle('show');
    sideBtn.classList.toggle('active', isOpen);
  });

  // Click outside sidebar to close
  document.addEventListener('click', (e)=>{
    if(sidebar.classList.contains('show') &&
       !sidebar.contains(e.target) &&
       e.target !== sideBtn){
      sidebar.classList.remove('show');
      sideBtn.classList.remove('active');
    }
  });
})();

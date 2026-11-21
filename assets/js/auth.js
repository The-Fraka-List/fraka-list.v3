diff --git a/main.js b/main.js
index 34aeec9..daa83ca 100644
--- a/main.js
+++ b/main.js
@@ -245,6 +245,14 @@ const AVATAR_DIR = 'assets/img/pfp/';
 const AVATAR_EXTENSIONS = ['png', 'webp', 'gif', 'jpg', 'jpeg', 'svg'];
 const AVATAR_DEFAULT_SRC = `${AVATAR_DIR}default.png`;
 
+// Escapa texto antes de meterlo en un template HTML (innerHTML). Todo nombre que venga de la URL,
+// de un JSON o (en el futuro) de un usuario debe pasar por aquí.
+function escapeHtml(value) {
+    return String(value ?? '').replace(/[&<>"']/g, ch => ({
+        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
+    })[ch]);
+}
+
 function getAvatarSrc(username, extensionIndex) {
     return `${AVATAR_DIR}${encodeURIComponent(username)}.${AVATAR_EXTENSIONS[extensionIndex]}`;
 }
@@ -368,7 +376,7 @@ function renderPlayerProfileProgress(username, progressData) {
             <div
                 class="profile-card__progress-track"
                 role="progressbar"
-                aria-label="Progreso de colección de ${username}"
+                aria-label="Progreso de colección de ${escapeHtml(username)}"
                 aria-valuemin="0"
                 aria-valuemax="100"
                 aria-valuenow="${percent}"
@@ -544,7 +552,7 @@ function openPlayerVideoConfirm(username, videoUrl) {
 
     overlay.innerHTML = `
         <div class="confirm-popup__content">
-            <p class="confirm-popup__text">¿Ir al video del jugador "${username}"?</p>
+            <p class="confirm-popup__text">¿Ir al video del jugador "${escapeHtml(username)}"?</p>
             <div class="confirm-popup__actions">
                 <button type="button" class="btn btn--secondary" id="confirm-popup-no">No</button>
                 <button type="button" class="btn btn--primary" id="confirm-popup-yes">Sí</button>
@@ -690,10 +698,10 @@ function renderPlayerProfileCard(username) {
                     <img
                         class="profile-card__avatar-img"
                         src="${getAvatarSrc(username, 0)}"
-                        data-avatar-username="${username}"
+                        data-avatar-username="${escapeHtml(username)}"
                         data-avatar-attempt="0"
                         onerror="handleAvatarError(this)"
-                        alt="${username}"
+                        alt="${escapeHtml(username)}"
                     >
                     </div>
                     <div class="profile-rank">
@@ -701,7 +709,7 @@ function renderPlayerProfileCard(username) {
                         <span class="profile-rank__label">RANK</span>
                     </div>
                 </div>
-                <h1 class="profile-card__name">${username}</h1>
+                <h1 class="profile-card__name">${escapeHtml(username)}</h1>
             </div>
         </div>
     `;
@@ -736,7 +744,11 @@ function handleHashRouting() {
 
     let targetSectionId;
     if (isProfileRoute) {
-        currentProfileUsername = decodeURIComponent(profileRouteParts[0] || '');
+        try {
+            currentProfileUsername = decodeURIComponent(profileRouteParts[0] || '');
+        } catch (_) {
+            currentProfileUsername = ''; // %XX mal formado en la URL
+        }
         if (profileRouteParts[1] === 'rising' || profileRouteParts[1] === 'list') {
             currentProfileListContext = profileRouteParts[1];
         }

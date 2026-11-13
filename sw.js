/* NESTOR hors ligne (demandé le 11/11/2026, à l'essai).
 *
 * Sans ce fichier, le site a besoin d'Internet à chaque ouverture et à chaque
 * changement d'onglet de fiche (la page se recharge) : réseau ou GitHub en
 * panne pendant une garde à vue, et NESTOR ne s'ouvrait plus alors que les
 * fiches sont dans le navigateur.
 *
 * Ce « service worker » garde en réserve, dans le navigateur, la page
 * d'accueil, les icônes et le dernier paquet chiffré ouvert. Avec le réseau,
 * rien ne change : la page d'accueil et version.json viennent toujours du
 * site (les mises à jour s'appliquent comme avant). Sans réseau, ou si le site
 * ne répond pas dans les 4 secondes, la réserve est servie. Le paquet reste
 * chiffré dans la réserve : la clé est toujours nécessaire pour l'ouvrir.
 *
 * Ne touche qu'aux fichiers du site lui-même (jamais aux services d'adresses
 * de l'État, jamais aux fiches). Site d'essai et vrai site : même domaine,
 * dossiers différents, donc une réserve chacun.
 *
 * Publié en clair à côté de la page d'accueil par scripts/publier.ps1. */
'use strict';

const DOSSIER = new URL(self.registration.scope).pathname;       // « /nestor-site/ »
const RESERVE = 'nestor-hors-ligne:' + DOSSIER;
const DELAI_RESEAU_MS = 4000;
const PAQUET = /^paquet-[0-9a-f]+\.bin$/;
const ICONES = ['favicon.svg', 'favicon.ico'];

function versionEnReserve(nomPaquet) {
    return new Response(JSON.stringify({ paquet: nomPaquet, reserve: true }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// Le paquet est dans la réserve : version.json de réserve pointé dessus,
// anciens paquets retirés. Le version.json de réserve désigne donc toujours
// un paquet réellement présent.
async function retenirPaquet(reserve, nomPaquet, reponse) {
    await reserve.put(DOSSIER + nomPaquet, reponse);
    await reserve.put(DOSSIER + 'version.json', versionEnReserve(nomPaquet));
    const cles = await reserve.keys();
    await Promise.all(cles.map(function (requete) {
        const nom = new URL(requete.url).pathname.slice(DOSSIER.length);
        return PAQUET.test(nom) && nom !== nomPaquet ? reserve.delete(requete) : null;
    }));
}

// À l'installation : tout ce qu'il faut pour ouvrir NESTOR sans réseau dès la
// prochaine fois (la page qui installe ce fichier a déjà fait ses chargements).
async function precharger() {
    const reserve = await caches.open(RESERVE);
    const accueil = await fetch(DOSSIER, { cache: 'no-store' });
    if (accueil.ok) await reserve.put(DOSSIER, accueil);
    await Promise.all(ICONES.map(async function (icone) {
        try {
            const r = await fetch(DOSSIER + icone, { cache: 'no-store' });
            if (r.ok) await reserve.put(DOSSIER + icone, r);
        } catch (e) { /* icône facultative */ }
    }));
    const version = await (await fetch(DOSSIER + 'version.json', { cache: 'no-store' })).json();
    if (version && PAQUET.test(version.paquet) && !(await reserve.match(DOSSIER + version.paquet))) {
        const paquet = await fetch(DOSSIER + version.paquet);
        if (paquet.ok) await retenirPaquet(reserve, version.paquet, paquet);
    }
}

self.addEventListener('install', function (event) {
    // Un préchargement raté (réseau coupé à cet instant) n'empêche pas
    // l'installation : la réserve se remplira aux chargements suivants.
    event.waitUntil(precharger().catch(function () {}));
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

// Le site d'abord ; la réserve s'il ne répond pas (erreur, hors ligne, ou plus
// de 4 secondes). `garder` : la réponse du site remplace celle de la réserve.
async function siteSinonReserve(requete, cle, garder) {
    const reserve = await caches.open(RESERVE);
    const enReserve = await reserve.match(cle);
    const duSite = fetch(requete).then(function (reponse) {
        if (reponse && reponse.ok && garder) reserve.put(cle, reponse.clone()).catch(function () {});
        return reponse;
    });
    if (!enReserve) return duSite;
    const attente = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, DELAI_RESEAU_MS); });
    try {
        const reponse = await Promise.race([duSite, attente]);
        if (reponse && reponse.ok) return reponse;
    } catch (e) { /* hors ligne */ }
    duSite.catch(function () {});
    return enReserve;
}

// Paquet : son nom change à chaque publication, son contenu jamais. La
// réserve d'abord, sinon le site (et il entre dans la réserve).
async function paquetReserveSinonSite(requete, nomPaquet) {
    const reserve = await caches.open(RESERVE);
    const enReserve = await reserve.match(DOSSIER + nomPaquet);
    if (enReserve) return enReserve;
    const reponse = await fetch(requete);
    if (reponse && reponse.ok) await retenirPaquet(reserve, nomPaquet, reponse.clone()).catch(function () {});
    return reponse;
}

self.addEventListener('fetch', function (event) {
    const requete = event.request;
    if (requete.method !== 'GET') return;
    const url = new URL(requete.url);
    if (url.origin !== self.location.origin || url.pathname.indexOf(DOSSIER) !== 0) return;
    const nom = url.pathname.slice(DOSSIER.length);

    if (nom === '' || nom === 'index.html') {
        event.respondWith(siteSinonReserve(requete, DOSSIER, true));
    } else if (nom === 'version.json') {
        // Jamais gardé tel quel : la réserve ne connaît que le paquet qu'elle a.
        event.respondWith(siteSinonReserve(requete, DOSSIER + 'version.json', false));
    } else if (PAQUET.test(nom)) {
        event.respondWith(paquetReserveSinonSite(requete, nom));
    } else if (ICONES.indexOf(nom) !== -1) {
        event.respondWith(siteSinonReserve(requete, DOSSIER + nom, true));
    }
});

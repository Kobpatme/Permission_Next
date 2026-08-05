  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
  import {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, doc, setDoc, deleteDoc, onSnapshot, runTransaction,
    writeBatch, getDocs, query, limit
  } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

  const firebaseConfig = {
    apiKey: "AIzaSyAHC-sAuMmtqz0LntL4HpMTrvONhCbRzbM",
    authDomain: "engineering-design-workload.firebaseapp.com",
    projectId: "engineering-design-workload",
    storageBucket: "engineering-design-workload.firebasestorage.app",
    messagingSenderId: "498204601291",
    appId: "1:498204601291:web:59ec024f8a3f1fb5bba44e",
    measurementId: "G-Q7K8HKLW7Q"
  };

  const app = initializeApp(firebaseConfig);
  // ชื่อฐานข้อมูล Firestore: "permission-building" (ต้องสร้างฐานข้อมูลนี้ไว้ล่วงหน้าใน Firebase Console
  // ที่ Databases & Storage > Firestore > Add database > Database ID = permission-building)
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  }, "permission-building");

  // ใช้ persistentLocalCache แทน enableIndexedDbPersistence() เพื่อลด warning deprecated ของ Firebase 10
  window.addEventListener('unhandledrejection', event => {
    if (String(event.reason?.message || '').includes('offline persistence')) {
      console.warn('Firestore offline persistence ไม่สามารถเปิดได้:', event.reason?.code || event.reason);
    }
  });

  const buildingsCol = collection(db, 'buildings');
  const authDocRef = doc(buildingsCol, 'permission_next_auth');
  const authBackupDocRef = doc(buildingsCol, 'permission_next_auth_backup');
  const protectedSystemDocIds = new Set([
    'permission_next_auth',
    'permission_next_auth_backup',
    'permission_type_formulas'
  ]);

  function assertBuildingDocIsNotProtected(id) {
    if (protectedSystemDocIds.has(String(id))) {
      throw new Error('ไม่อนุญาตให้แก้ไขหรือลบเอกสารระบบผ่านคำสั่งจัดการอาคาร');
    }
  }

  function authUsersFromSnapshot(snap) {
    const data = snap?.exists() ? snap.data() : {};
    return Array.isArray(data.users) ? data.users : [];
  }

  function authRevisionFromSnapshot(snap) {
    const data = snap?.exists() ? snap.data() : {};
    return Number(data.revision) || 0;
  }

  function chooseProtectedAuthUsers(primarySnap, backupSnap) {
    const primaryUsers = authUsersFromSnapshot(primarySnap);
    const backupUsers = authUsersFromSnapshot(backupSnap);
    const primaryRevision = authRevisionFromSnapshot(primarySnap);
    const backupRevision = authRevisionFromSnapshot(backupSnap);
    const primaryLooksDamaged = backupUsers.length > primaryUsers.length
      && backupRevision >= primaryRevision;

    if ((!primarySnap.exists() || !primaryUsers.length || primaryLooksDamaged) && backupUsers.length) {
      return {
        users: backupUsers,
        revision: Math.max(primaryRevision, backupRevision),
        restorePrimary: true
      };
    }
    return {
      users: primaryUsers,
      revision: Math.max(primaryRevision, backupRevision),
      restorePrimary: false
    };
  }

  async function recoverProtectedAuthUsers() {
    return runTransaction(db, async transaction => {
      const [primarySnap, backupSnap] = await Promise.all([
        transaction.get(authDocRef),
        transaction.get(authBackupDocRef)
      ]);
      const protectedState = chooseProtectedAuthUsers(primarySnap, backupSnap);
      const now = new Date().toISOString();

      if (protectedState.restorePrimary) {
        transaction.set(authDocRef, {
          _kind: 'permission_next_auth',
          users: protectedState.users,
          revision: protectedState.revision,
          updated_at: now,
          restored_at: now
        }, { merge: true });
      } else if (protectedState.users.length && (
        !backupSnap.exists()
        || authRevisionFromSnapshot(backupSnap) < protectedState.revision
        || authUsersFromSnapshot(backupSnap).length !== protectedState.users.length
      )) {
        transaction.set(authBackupDocRef, {
          _kind: 'permission_next_auth',
          users: protectedState.users,
          revision: protectedState.revision,
          updated_at: now
        }, { merge: true });
      }
      return protectedState.users;
    });
  }

  async function mutateProtectedAuthUsers(mutator) {
    return runTransaction(db, async transaction => {
      const [primarySnap, backupSnap] = await Promise.all([
        transaction.get(authDocRef),
        transaction.get(authBackupDocRef)
      ]);
      const protectedState = chooseProtectedAuthUsers(primarySnap, backupSnap);
      const nextUsers = mutator([...protectedState.users]);
      const revision = protectedState.revision + 1;
      const now = new Date().toISOString();
      const payload = {
        _kind: 'permission_next_auth',
        users: nextUsers,
        revision,
        updated_at: now
      };

      transaction.set(authDocRef, payload, { merge: true });
      transaction.set(authBackupDocRef, payload, { merge: true });
      return nextUsers;
    });
  }

  // เปิด API ชุดเล็ก ๆ ให้สคริปต์หลัก (classic script) ของแอปเรียกใช้ผ่าน window.FSDB
  window.FSDB = {
    newId: () => doc(buildingsCol).id,
    async isCollectionEmpty() {
      const snap = await getDocs(query(buildingsCol, limit(1)));
      return snap.empty;
    },
    newBatch: () => writeBatch(db),
    setInBatch(batch, id, data) {
      assertBuildingDocIsNotProtected(id);
      return batch.set(doc(buildingsCol, String(id)), data);
    },
    setMergeInBatch(batch, id, data) {
      assertBuildingDocIsNotProtected(id);
      return batch.set(doc(buildingsCol, String(id)), data, { merge: true });
    },
    commitBatch: (batch) => batch.commit(),
    setDoc(id, data) {
      assertBuildingDocIsNotProtected(id);
      return setDoc(doc(buildingsCol, String(id)), data, { merge: true });
    },
    deleteDoc(id) {
      assertBuildingDocIsNotProtected(id);
      return deleteDoc(doc(buildingsCol, String(id)));
    },
    onSnapshot: (onNext, onError) => onSnapshot(buildingsCol, onNext, onError),
    getAuthUsers: () => recoverProtectedAuthUsers(),
    onAuthSnapshot: (onNext, onError) => onSnapshot(authDocRef, async () => {
      try {
        onNext(await recoverProtectedAuthUsers());
      } catch (err) {
        if (onError) onError(err);
      }
    }, onError),
    async getUser(email) {
      const cleanEmail = String(email).toLowerCase();
      const users = await this.getAuthUsers();
      return users.find(user => String(user.email || '').toLowerCase() === cleanEmail) || null;
    },
    async setUser(email, data) {
      const cleanEmail = String(email).toLowerCase();
      await mutateProtectedAuthUsers(users => {
        const nextUsers = users.filter(user => String(user.email || '').toLowerCase() !== cleanEmail);
        nextUsers.push({ ...data, email: cleanEmail });
        return nextUsers;
      });
    },
    async deleteUser(email) {
      const cleanEmail = String(email).toLowerCase();
      await mutateProtectedAuthUsers(users =>
        users.filter(user => String(user.email || '').toLowerCase() !== cleanEmail)
      );
    }
  };

  window.dispatchEvent(new Event('fsdb-ready'));

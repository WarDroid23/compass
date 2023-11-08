import type { Store } from 'redux';
import { createStore, applyMiddleware } from 'redux';
import throttle from 'lodash/throttle';
import thunk from 'redux-thunk';
import { globalAppRegistryActivated } from '@mongodb-js/mongodb-redux-common/app-registry';
import type { RootAction, RootState } from '../modules';
import reducer from '../modules';
import { changeInstance } from '../modules/instance';
import { changeLocation } from '../modules/location';
import type { Database } from '../modules/databases';
import { changeActiveNamespace, changeDatabases } from '../modules/databases';
import { reset } from '../modules/reset';
import { toggleIsGenuineMongoDBVisible } from '../modules/is-genuine-mongodb-visible';
import { changeConnectionInfo } from '../modules/connection-info';
import { changeConnectionOptions } from '../modules/connection-options';
import { toggleSidebar } from '../modules/is-expanded';
import type AppRegistry from 'hadron-app-registry';
import type { MongoDBInstance } from 'mongodb-instance-model';

// We use these symbols so that nothing from outside can access these values on
// the store
const kInstance = Symbol('instance');

const store: Store<RootState, RootAction> & {
  [kInstance]: null | MongoDBInstance;
} = Object.assign(createStore(reducer, applyMiddleware(thunk)), {
  [kInstance]: null,
});

const onActivated = (appRegistry: AppRegistry) => {
  const onInstanceChangeNow = (instance: any /* MongoDBInstance */) => {
    store.dispatch(
      changeInstance({
        refreshingStatus: instance.refreshingStatus,
        databasesStatus: instance.databasesStatus,
        csfleMode: instance.csfleMode,
        build: instance.build.toJSON(),
        dataLake: instance.dataLake.toJSON(),
        genuineMongoDB: instance.genuineMongoDB.toJSON(),
        topologyDescription: instance.topologyDescription.toJSON(),
        isWritable: instance.isWritable,
        env: instance.env,
        isAtlas: instance.isAtlas,
        isLocalAtlas: instance.isLocalAtlas,
      })
    );
  };

  const onInstanceChange = throttle((instance) => {
    onInstanceChangeNow(instance);
  }, 300);

  function getDatabaseInfo(db: Database) {
    return {
      _id: db._id,
      name: db.name,
      collectionsStatus: db.collectionsStatus,
      collectionsLength: db.collectionsLength,
    };
  }

  function getCollectionInfo(coll: Database['collections'][number]) {
    return {
      _id: coll._id,
      name: coll.name,
      type: coll.type,
    };
  }

  const onDatabasesChange = throttle((databases: Database[]) => {
    const dbs = databases.map((db) => {
      return {
        ...getDatabaseInfo(db),
        collections: db.collections.map((coll) => {
          return getCollectionInfo(coll);
        }),
      };
    });

    store.dispatch(changeDatabases(dbs));
  }, 300);

  store.dispatch(globalAppRegistryActivated(appRegistry));

  appRegistry.on('data-service-connected', (_, dataService, connectionInfo) => {
    store.dispatch(changeConnectionInfo(connectionInfo));
    const connectionOptions = dataService.getConnectionOptions();
    store.dispatch(changeConnectionOptions(connectionOptions)); // stores ssh tunnel status

    appRegistry.removeAllListeners('sidebar-toggle-csfle-enabled');
    appRegistry.on('sidebar-toggle-csfle-enabled', (enabled) => {
      dataService.setCSFLEEnabled(enabled);
      appRegistry.emit('refresh-data');
    });
  });

  appRegistry.on('instance-destroyed', () => {
    const instance = store[kInstance] as any;
    if (instance) {
      instance.off();
      instance.build.off();
      instance.dataLake.off();
      instance.genuineMongoDB.off();
    }
    store[kInstance] = null;
    onInstanceChange.cancel();
    onDatabasesChange.cancel();
  });

  appRegistry.on('instance-created', ({ instance }) => {
    if (store[kInstance]) {
      // we should probably throw in this case
      return;
    }

    store[kInstance] = instance;

    onInstanceChangeNow(instance);
    onDatabasesChange(instance.databases);

    instance.on('change:csfleMode', () => {
      onInstanceChange(instance);
    });

    instance.on('change:refreshingStatus', () => {
      // This will always fire when we start fetching the instance details which
      // will cause a 300ms throttle before any instance details can update if
      // we send it though the throttled update. That's long enough for the
      // sidebar to display that we're connected to a standalone instance when
      // we're really connected to dataLake.
      onInstanceChangeNow(instance);
    });

    instance.on('change:databasesStatus', () => {
      onInstanceChange(instance);
      onDatabasesChange(instance.databases);
    });

    instance.on('change:databases', () => {
      onDatabasesChange(instance.databases);
    });

    instance.on('change:databases.collectionsStatus', () => {
      onDatabasesChange(instance.databases);
    });

    instance.build.on('change:isEnterprise', () => {
      onInstanceChange(instance);
    });

    instance.build.on('change:version', () => {
      onInstanceChange(instance);
    });

    instance.dataLake.on('change:isDataLake', () => {
      onInstanceChange(instance);
    });

    instance.dataLake.on('change:version', () => {
      onInstanceChange(instance);
    });

    store.dispatch(
      toggleIsGenuineMongoDBVisible(!instance.genuineMongoDB.isGenuine)
    );

    instance.genuineMongoDB.on(
      'change:isGenuine',
      (model: unknown, isGenuine: boolean) => {
        onInstanceChange(instance); // isGenuineMongoDB is part of instance state
        store.dispatch(toggleIsGenuineMongoDBVisible(!isGenuine));
      }
    );

    instance.on('change:topologyDescription', () => {
      onInstanceChange(instance);
    });

    instance.on('change:isWritable', () => {
      onInstanceChange(instance);
    });

    instance.on('change:env', () => {
      onInstanceChange(instance);
    });
  });

  appRegistry.on('select-namespace', ({ namespace }) => {
    store.dispatch(changeActiveNamespace(namespace));
    store.dispatch(changeLocation('collection'));
  });

  appRegistry.on('open-namespace-in-new-tab', ({ namespace }) => {
    store.dispatch(changeActiveNamespace(namespace));
    store.dispatch(changeLocation('collection'));
  });

  appRegistry.on('select-database', (dbName) => {
    store.dispatch(changeActiveNamespace(dbName));
    store.dispatch(changeLocation('database'));
  });

  appRegistry.on('open-instance-workspace', (tabName = null) => {
    store.dispatch(changeActiveNamespace(''));
    store.dispatch(changeLocation(tabName));
  });

  appRegistry.on('data-service-disconnected', () => {
    store.dispatch(reset());
  });

  appRegistry.on('toggle-sidebar', () => {
    store.dispatch(toggleSidebar());
  });
};

export default Object.assign(store, { onActivated });
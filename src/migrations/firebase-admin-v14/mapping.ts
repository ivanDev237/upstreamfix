// Namespaced API → modular API, from https://firebase.google.com/docs/admin/migrate-node-v10
// The namespaced API was removed in firebase-admin v14.0.0 (firebase-admin-node#3164).

export interface ServiceMapping {
  getter: string;
  module: string;
  /** Values exposed as `admin.<service>.<Name>` that are now named exports of the module. */
  statics: string[];
  /** Types removed in v14 with no drop-in replacement. */
  removedTypes?: string[];
}

export const SERVICES: Record<string, ServiceMapping> = {
  firestore: {
    getter: 'getFirestore',
    module: 'firebase-admin/firestore',
    statics: [
      'FieldValue',
      'Timestamp',
      'FieldPath',
      'GeoPoint',
      'Filter',
      'AggregateField',
      'DocumentReference',
      'CollectionReference',
      'Query',
      'WriteBatch',
      'Transaction',
      'BulkWriter',
      'setLogFunction',
    ],
  },
  auth: { getter: 'getAuth', module: 'firebase-admin/auth', statics: [] },
  messaging: {
    getter: 'getMessaging',
    module: 'firebase-admin/messaging',
    statics: [],
    // Legacy FCM types removed in firebase-admin-node#3157.
    removedTypes: [
      'MessagingPayload',
      'MessagingOptions',
      'DataMessagePayload',
      'NotificationMessagePayload',
      'MessagingDevicesResponse',
      'MessagingDeviceResult',
      'MessagingDeviceGroupResponse',
      'MessagingTopicResponse',
      'MessagingConditionResponse',
    ],
  },
  storage: { getter: 'getStorage', module: 'firebase-admin/storage', statics: [] },
  database: {
    getter: 'getDatabase',
    module: 'firebase-admin/database',
    statics: ['ServerValue', 'enableLogging'],
  },
  appCheck: { getter: 'getAppCheck', module: 'firebase-admin/app-check', statics: [] },
  remoteConfig: { getter: 'getRemoteConfig', module: 'firebase-admin/remote-config', statics: [] },
  securityRules: { getter: 'getSecurityRules', module: 'firebase-admin/security-rules', statics: [] },
  projectManagement: {
    getter: 'getProjectManagement',
    module: 'firebase-admin/project-management',
    statics: [],
  },
  machineLearning: {
    getter: 'getMachineLearning',
    module: 'firebase-admin/machine-learning',
    statics: [],
  },
  installations: { getter: 'getInstallations', module: 'firebase-admin/installations', statics: [] },
  functions: { getter: 'getFunctions', module: 'firebase-admin/functions', statics: [] },
  eventarc: { getter: 'getEventarc', module: 'firebase-admin/eventarc', statics: [] },
};

export const APP_MODULE = 'firebase-admin/app';

/** `admin.credential.<name>()` → `<name>()` from firebase-admin/app. */
export const CREDENTIAL_FACTORIES = ['cert', 'applicationDefault', 'refreshToken'];

/** Types still exported by the `firebase-admin` entry point in v14. */
export const ROOT_TYPES = [
  'App',
  'AppOptions',
  'Credential',
  'ServiceAccount',
  'GoogleOAuthAccessToken',
  'FirebaseError',
  'FirebaseArrayIndexError',
  'ErrorInfo',
];

export const REMOVED_SERVICES: Record<string, string> = {
  instanceId: 'Instance ID was removed in v14: migrate to getInstallations() from firebase-admin/installations.',
};

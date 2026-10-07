// A self-signed certificate for the lan transport's tests (a desk's LAN
// gateway presents one like it), generated once with:
//
//   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
//     -days 36500 -subj /CN=gaiadesk-lan -keyout key.pem -out cert.pem
//   openssl x509 -in cert.pem -noout -fingerprint -sha256
//
// A test key only: it guards nothing.

export const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJy6rA/GGRu4Ys5rq
Ppy8sxStq9K1GFTIDqZttwxkbj+hRANCAAQYTwapLzHPm2CfU2ajkt1wLNUK8n36
kzo8PUK2D6HiYWHYuenad2MTEPPwSF56M3qReRQhUhSfmc5SLhlE6ZTI
-----END PRIVATE KEY-----
`;

export const CERT = `-----BEGIN CERTIFICATE-----
MIIBYzCCAQqgAwIBAgIUaEZ3Bqb49fSJV98M5DIU1D1TrY4wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMZ2FpYWRlc2stbGFuMCAXDTI2MTAwNzIzMzMyMFoYDzIxMjYw
OTEzMjMzMzIwWjAXMRUwEwYDVQQDDAxnYWlhZGVzay1sYW4wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQYTwapLzHPm2CfU2ajkt1wLNUK8n36kzo8PUK2D6HiYWHY
uenad2MTEPPwSF56M3qReRQhUhSfmc5SLhlE6ZTIozIwMDAdBgNVHQ4EFgQU2Ns7
imQjuFJKjOPf+W6xd59aRhAwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNH
ADBEAiA2MZ281dwgjR5chvoWpVn1TVQ6/lBDesTF676ReQEQRAIgOtczSp7ENu6q
T9BBurg8tsBEnERMfw4vq4hRw12GGcg=
-----END CERTIFICATE-----
`;

/** `openssl x509 -fingerprint -sha256` of CERT, as openssl prints it (uppercase, colons). */
export const FINGERPRINT = '74:DD:5E:7D:57:5C:3D:14:8E:8E:58:DA:27:37:18:1E:F7:93:AA:6B:45:F7:6C:A2:94:0A:23:D0:7D:40:EB:61';

/** The fingerprint of another certificate made the same way: a desk that is not the pinned one. */
export const OTHER_FINGERPRINT = '25:EC:36:2B:FD:89:C1:7C:32:7F:E2:78:B2:E9:FB:D8:8A:8E:06:75:67:8C:AB:12:94:6B:78:A7:56:0C:C1:91';

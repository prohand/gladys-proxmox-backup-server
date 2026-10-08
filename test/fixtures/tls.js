// -----------------------------------------------------------------------------
// Self-signed certificate for the local HTTPS server the client tests start.
//
// This is a TEST FIXTURE, not a credential: it is issued for `localhost`, its
// private key is deliberately public, and nothing outside `test/` loads it.
// Regenerate it with:
//
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
//     -days 36500 -nodes -subj "/CN=localhost" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
//   openssl x509 -in cert.pem -noout -fingerprint -sha256
// -----------------------------------------------------------------------------

export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUL16QF4CKrlN9mStuXbdi3iQt44owDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwODE3NTMxNloYDzIxMjYw
OTE0MTc1MzE2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDDP8KsuyAAEwBhCou7ozB6bnM+oeJbosdiDihupGYy
Z8KyVvceb1hb0AXzNG/QaRs4MzzdTbERExgI5WIe7CyNIug2BkXZwo88bjp7Fbtg
QwN0SbbwTrfz51DPhfrGES3jTrS1IbFICIbZpmx7pmQV+tNiUjq61ZQ55Tv2RbDl
3ZlyfbDO9DD9MAU9seRKRh3nM5YFOTrOkouuzFfgTQ2ELZVPRz3mn1pKvZMIq1+V
WIn7FJzJ3Pjl3en3u4bhJAdjU5POR+yf5PStFKvXjK/1wMxR72y5Q+E9mYPTZpU1
KHtbQgsMeMe3O46zVTe/zq3+Iy9jw9mqKgbpBrjthuIhAgMBAAGjbzBtMB0GA1Ud
DgQWBBROvdxmS6/gM6MVJ8sP3jvCUMCA8jAfBgNVHSMEGDAWgBROvdxmS6/gM6MV
J8sP3jvCUMCA8jAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAafNr8uIGcX2gG4rifn8XyQAyPJmd
lz29CT+RuxcYHpkoW4XVIgZfs4+wUyfpZa9lYwoQjR9bLP4xFT2au9cezEgyXVQu
SY9sy/9x9jtbK39SPSyOHHSykGZ6lUYq3z8wSeGId/l1+A5XQO2T4B4LGCGNN/vc
CQiPNhrGadXbU+IXu4dfihzubnZ7m4Bcl0OBjRiVvUnzNdFRTtqvbCynnR5BraTE
3x8teefOAS0OAeD0KXJ9TTzv2fMb/ZI8nUczrlflQ+t1uwCPL76NxTSsGOYkZ6hs
uE45ALQ/FOO6Rcj1X2OyTBqnBx9/vTuiE8k+yl5fHe5KJ4+ioiux9vU0UA==
-----END CERTIFICATE-----
`;

export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDDP8KsuyAAEwBh
Cou7ozB6bnM+oeJbosdiDihupGYyZ8KyVvceb1hb0AXzNG/QaRs4MzzdTbERExgI
5WIe7CyNIug2BkXZwo88bjp7FbtgQwN0SbbwTrfz51DPhfrGES3jTrS1IbFICIbZ
pmx7pmQV+tNiUjq61ZQ55Tv2RbDl3ZlyfbDO9DD9MAU9seRKRh3nM5YFOTrOkouu
zFfgTQ2ELZVPRz3mn1pKvZMIq1+VWIn7FJzJ3Pjl3en3u4bhJAdjU5POR+yf5PSt
FKvXjK/1wMxR72y5Q+E9mYPTZpU1KHtbQgsMeMe3O46zVTe/zq3+Iy9jw9mqKgbp
BrjthuIhAgMBAAECggEADyRyxKf+jgLrP0YXcDCdIeGkWRx/oaZjhYdI5iEki+Q1
hVSZSxL3l1HwJDHSOieXT38pyUAClisU7MZdcGiAoVwuW4JBCJJo6Ww4Z4itRNnt
pVHSOPDh81iNO+BNgpmdJXPahUcHqL6AjCthXnWZGDChFDmsXwZmvda5anAdOAvE
4uAZsduaaC/ksV3Ohox1AMkeG9ZdVbfl4wxMovHwdSMDU/1aDYRDP2yN6mpbut/q
aglFLsRi14YcAa+k7RwXnOdHO1qM+m6Hr+5Bv56fL9Ef5cDTDZDuFTWuDbQtdWbZ
VhnfEuOEME1+xVHviWM9ISKO4tLqvwmGr1lLmX5PwQKBgQDtPjyL3/ydSZX2YF7s
e/XQcifmqStdogMJRY3q4hJeeBh7A7K6Vh28TNvCBU2o9X/Iy6zN7JaugcLemjfB
PdHFeNdZ0hpcEvT5IsoGuSzNehktOjZsgZ12KduCFB/7eZN5oKtTEpnneF2pY3Qw
rwnDWv6LjkznVvpzK+YSAiCOuwKBgQDSr5IsWzmUDERBTXvN8xl1WkcbXbWPvRYL
IJrZSYQdohG4szw8GZcRlWWTryNheacPqOhAFowNWbc04NKu9+MTy+r14+lzjoG9
S/CSJzh09mag5S9KK6FD0TPE3g4qChKEs/rshWzkFSUgzhjs+cvXWDZeQeYC4ZxZ
zlIQnhLa0wKBgQDIn5HaA29/n2PWtsZvG6DTRkYh1Dtc8g25QH1z/PvlsY+aL5Vr
6Dk7LI/Gcm+rCvil2D9o4MLIDem6DxZJLzr+0GLkjT1HUayiJl5L8zpFBRTXX1v4
xF9hNqJvTQ+CvNwOxeU72gYWbX5fKUBvjwYlkwShBZRZKf+fd6cW4X+g0wKBgAaj
c5akNTc9/7STDXCa1VWGR7FMDZl+2r/1AgwQrfIFFkvckexO3hy2uWGi5hl/LM1o
hBDo5PbSudwXrWvH8cbA6SFgUg3LErl1OBpS1AuTa/5r2kabA1TQtbHhUU7vzE+U
IDbtqVWyeN4EwHJPGKYraGMl7mpu029c+eb+JBfzAoGAI1opRJm998BUFmCqlQJS
DqX57VIbtzJ9huz7AFfnW8LWhZOd08mTYvyVM8qEoRbBpbUbpEPTBZGIPUwqiLu1
3uzBaDpOs+Cjnp1EGIO1y1WjySmN3JSGZSxD5T0nOC4ZSzErImzn9N05PPTfowud
RKj/d67cOZEF2xowk7V9xF4=
-----END PRIVATE KEY-----
`;

export const TEST_FINGERPRINT =
  '53:09:2F:F7:B7:9A:26:E9:CF:45:7B:18:6A:11:09:C8:DB:A8:06:7E:D0:28:DF:31:9C:64:89:3C:35:0F:7A:E6';

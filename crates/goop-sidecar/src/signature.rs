//! Verifies the OpenPGP signature an upstream publishes over its release
//! checksum manifest, against a signing key compiled into Goop.
//!
//! A SHA-256 manifest served from the same release as the binary it vouches
//! for proves nothing by itself: whoever can replace the binary can replace
//! the manifest too. The signature is what ties the manifest to the upstream
//! maintainer's key, which someone who only controls the release host does
//! not hold.
//!
//! Deliberately narrow. Both upstreams publish exactly one shape — a binary
//! version 4 detached signature over the manifest, RSA, SHA-512 — so this
//! accepts that shape (with SHA-256/384/512) and refuses everything else
//! instead of growing into a general OpenPGP implementation. ring, already in
//! the tree for TLS, does the RSA arithmetic; this module only parses the two
//! packet types involved and assembles the bytes RFC 4880 §5.2.4 has the
//! signer hash.
//!
//! The pin replaces the web of trust. Only the packet whose fingerprint is
//! pinned is used; user IDs, self-signatures and other subkeys in the block
//! are never consulted, and neither is a revocation or an expiry on the key
//! itself — if upstream revokes a key, Goop keeps trusting it until a release
//! drops it. Rotating a key likewise means shipping a Goop release with the new
//! fingerprint. Until then a signature by the new key alone is refused (one
//! that also carries a signature by the old key still verifies), and the error
//! names the key that signed so it can be checked against upstream.

use base64::Engine as _;
use ring::digest;
use ring::signature::{self as rsa, RsaPublicKeyComponents};
use std::time::SystemTime;

const SIGNATURE_TAG: u8 = 2;
const PUBLIC_KEY_TAG: u8 = 6;
const PUBLIC_SUBKEY_TAG: u8 = 14;
const RSA_ALGORITHM: u8 = 1;
const BINARY_DOCUMENT: u8 = 0x00;
const SIG_CREATION_TIME: u8 = 2;
const SIG_EXPIRATION_TIME: u8 = 3;
const ISSUER_FINGERPRINT: u8 = 33;
const CRITICAL: u8 = 0x80;
const ARMOR_BEGIN: &str = "-----BEGIN PGP PUBLIC KEY BLOCK-----";

type Fingerprint = [u8; 20];

/// An upstream signing key, pinned by its OpenPGP v4 fingerprint.
pub(crate) struct TrustedKey {
    /// Forty hex digits, as `gpg --fingerprint` prints them without the spaces.
    pub(crate) fingerprint: &'static str,
    /// The upstream's armored public key block.
    pub(crate) armored: &'static str,
}

/// Why a signature was refused. Every variant means "install nothing".
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum SignatureError {
    #[error("the pinned signing key {fingerprint} could not be loaded: {reason}")]
    PinnedKey {
        fingerprint: &'static str,
        reason: &'static str,
    },
    #[error("the signature is malformed: {0}")]
    Malformed(&'static str),
    #[error("the signature uses {0}, which Goop does not accept")]
    Unsupported(String),
    #[error("the signature was made by key {0}, which Goop does not trust")]
    UntrustedKey(String),
    #[error("the signature has expired")]
    Expired,
    #[error("the signature does not match the checksum file")]
    Mismatch,
}

/// Verify a binary detached signature over `data`, made by one of `trusted`.
///
/// Every pinned key is loaded first, so a key that no longer parses fails
/// every update rather than only the ones it happens to sign.
///
/// The file may hold several signatures — an upstream moving to a new key can
/// sign with both — and one by a trusted key that verifies is enough. When
/// none does, the error is the one that got furthest: a trusted key's verdict
/// says more than an unknown key, which says more than an unreadable packet.
pub(crate) fn verify_detached(
    trusted: &[TrustedKey],
    data: &[u8],
    signature: &[u8],
    now: SystemTime,
) -> Result<(), SignatureError> {
    let keys = trusted
        .iter()
        .map(load_pinned_key)
        .collect::<Result<Vec<_>, _>>()?;

    let mut furthest: Option<SignatureError> = None;
    for packet in signature_packets(signature)? {
        match parse_signature(packet).and_then(|sig| verify_one(&keys, data, &sig, now)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                if furthest.as_ref().is_none_or(|f| progress(&e) > progress(f)) {
                    furthest = Some(e);
                }
            }
        }
    }
    Err(furthest.unwrap_or(SignatureError::Malformed("no signature")))
}

/// Check one parsed signature against the pinned keys.
fn verify_one(
    keys: &[PublicKey],
    data: &[u8],
    sig: &Signature<'_>,
    now: SystemTime,
) -> Result<(), SignatureError> {
    let key = keys
        .iter()
        .find(|k| k.fingerprint == sig.issuer)
        .ok_or_else(|| SignatureError::UntrustedKey(to_hex(&sig.issuer)))?;

    if let Some(lifetime) = sig.expires_after.filter(|&secs| secs != 0) {
        // A clock set before 1970 cannot place the expiry, so count it as
        // passed rather than as never reached.
        let now = now
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(u64::MAX, |d| d.as_secs());
        if now >= u64::from(sig.created) + u64::from(lifetime) {
            return Err(SignatureError::Expired);
        }
    }

    // RFC 4880 §5.2.4: the document, then the hashed part of the packet, then
    // a trailer giving that part's length — at most six octets plus 65,535 of
    // subpackets, so it always fits the trailer's four.
    let hashed_len = u32::try_from(sig.hashed.len())
        .map_err(|_| SignatureError::Malformed("an oversized hashed area"))?;
    let message = [data, sig.hashed, &[4, 0xFF], &hashed_len.to_be_bytes()].concat();

    // The packet carries the digest's first two octets as a quick check. It
    // proves nothing on its own, but a mismatch is a corrupt signature.
    if digest::digest(sig.hash.digest(), &message).as_ref()[..2] != sig.digest_prefix[..] {
        return Err(SignatureError::Mismatch);
    }

    // An MPI drops leading zero octets; RSA wants the value at the modulus's
    // full width.
    let pad = key
        .n
        .len()
        .checked_sub(sig.value.len())
        .ok_or(SignatureError::Mismatch)?;
    let mut value = vec![0; pad];
    value.extend_from_slice(sig.value);

    RsaPublicKeyComponents {
        n: &key.n,
        e: &key.e,
    }
    .verify(sig.hash.rsa_parameters(), &message, &value)
    .map_err(|_| SignatureError::Mismatch)
}

/// How far a signature got before it was refused, to pick the most telling
/// failure among several.
fn progress(e: &SignatureError) -> u8 {
    match e {
        SignatureError::PinnedKey { .. } | SignatureError::Malformed(_) => 0,
        SignatureError::Unsupported(_) => 1,
        SignatureError::UntrustedKey(_) => 2,
        SignatureError::Expired | SignatureError::Mismatch => 3,
    }
}

/// The bodies of the signature packets in a detached signature file. Anything
/// that is not a well-framed signature packet makes the whole file malformed.
fn signature_packets(input: &[u8]) -> Result<Vec<&[u8]>, SignatureError> {
    use SignatureError::Malformed;

    if input.is_empty() {
        return Err(Malformed("no signature"));
    }
    let mut bodies = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        let (tag, body, tail) = next_packet(rest).map_err(Malformed)?;
        if tag != SIGNATURE_TAG {
            return Err(Malformed("not a signature packet"));
        }
        bodies.push(body);
        rest = tail;
    }
    Ok(bodies)
}

/// An RSA public key, as far as verifying needs it.
struct PublicKey {
    fingerprint: Fingerprint,
    n: Vec<u8>,
    e: Vec<u8>,
}

/// The hash algorithms accepted, by OpenPGP algorithm ID.
#[derive(Clone, Copy)]
enum Hash {
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn from_id(id: u8) -> Option<Self> {
        match id {
            8 => Some(Self::Sha256),
            9 => Some(Self::Sha384),
            10 => Some(Self::Sha512),
            _ => None,
        }
    }

    fn digest(self) -> &'static digest::Algorithm {
        match self {
            Self::Sha256 => &digest::SHA256,
            Self::Sha384 => &digest::SHA384,
            Self::Sha512 => &digest::SHA512,
        }
    }

    fn rsa_parameters(self) -> &'static rsa::RsaParameters {
        match self {
            Self::Sha256 => &rsa::RSA_PKCS1_2048_8192_SHA256,
            Self::Sha384 => &rsa::RSA_PKCS1_2048_8192_SHA384,
            Self::Sha512 => &rsa::RSA_PKCS1_2048_8192_SHA512,
        }
    }
}

/// The parts of a signature packet verifying needs.
struct Signature<'a> {
    /// The packet body from its version octet to the end of the hashed
    /// subpackets — what the signer hashes after the document.
    hashed: &'a [u8],
    hash: Hash,
    issuer: Fingerprint,
    created: u32,
    /// Seconds after `created`; zero means it never expires.
    expires_after: Option<u32>,
    digest_prefix: &'a [u8],
    value: &'a [u8],
}

/// Parse a signature packet's body.
fn parse_signature(body: &[u8]) -> Result<Signature<'_>, SignatureError> {
    use SignatureError::{Malformed, Unsupported};

    let mut r = Reader(body);
    let version = r.u8().map_err(Malformed)?;
    if version != 4 {
        return Err(Unsupported(format!("a version {version} signature")));
    }
    let sig_type = r.u8().map_err(Malformed)?;
    if sig_type != BINARY_DOCUMENT {
        return Err(Unsupported(format!("signature type {sig_type:#04x}")));
    }
    let algorithm = r.u8().map_err(Malformed)?;
    if algorithm != RSA_ALGORITHM {
        return Err(Unsupported(format!("public-key algorithm {algorithm}")));
    }
    let hash_id = r.u8().map_err(Malformed)?;
    let hash =
        Hash::from_id(hash_id).ok_or_else(|| Unsupported(format!("hash algorithm {hash_id}")))?;

    let hashed_len = usize::from(r.u16().map_err(Malformed)?);
    let subpackets = r.take(hashed_len).map_err(Malformed)?;
    let hashed = &body[..body.len() - r.rest().len()];
    // Not covered by the signature, so nothing in it can be trusted — not
    // even the issuer key ID gpg puts there.
    let unhashed_len = usize::from(r.u16().map_err(Malformed)?);
    r.take(unhashed_len).map_err(Malformed)?;
    let digest_prefix = r.take(2).map_err(Malformed)?;
    let value = r.mpi().map_err(Malformed)?;
    if !r.rest().is_empty() {
        return Err(Malformed("trailing bytes in the signature packet"));
    }

    let fields = parse_hashed_subpackets(subpackets)?;
    Ok(Signature {
        hashed,
        hash,
        issuer: fields.issuer,
        created: fields.created,
        expires_after: fields.expires_after,
        digest_prefix,
        value,
    })
}

struct HashedFields {
    issuer: Fingerprint,
    created: u32,
    expires_after: Option<u32>,
}

/// Read the subpackets the signature covers. An unknown one marked critical
/// makes the signature invalid (RFC 4880 §5.2.3.1).
fn parse_hashed_subpackets(area: &[u8]) -> Result<HashedFields, SignatureError> {
    use SignatureError::{Malformed, Unsupported};

    let mut issuer = None;
    let mut created = None;
    let mut expires_after = None;
    let mut r = Reader(area);
    while !r.rest().is_empty() {
        let len = r.subpacket_len().map_err(Malformed)?;
        let (&kind, data) = r
            .take(len)
            .map_err(Malformed)?
            .split_first()
            .ok_or(Malformed("an empty subpacket"))?;
        match kind & !CRITICAL {
            SIG_CREATION_TIME => created = Some(be_u32(data)?),
            SIG_EXPIRATION_TIME => expires_after = Some(be_u32(data)?),
            ISSUER_FINGERPRINT => match data.split_first() {
                Some((&4, fpr)) => {
                    issuer = Some(
                        Fingerprint::try_from(fpr)
                            .map_err(|_| Malformed("an issuer fingerprint of the wrong length"))?,
                    )
                }
                _ => return Err(Unsupported("a non-v4 issuer fingerprint".into())),
            },
            other if kind & CRITICAL != 0 => {
                return Err(Unsupported(format!("critical subpacket {other}")))
            }
            _ => {}
        }
    }
    // Older signers name only the issuer's key ID, and only in the unhashed
    // area. Nothing there can be trusted, so such a signature is refused.
    let issuer =
        issuer.ok_or_else(|| Unsupported("no hashed issuer fingerprint subpacket".into()))?;
    Ok(HashedFields {
        issuer,
        created: created.ok_or(Malformed("no creation time"))?,
        expires_after,
    })
}

fn be_u32(data: &[u8]) -> Result<u32, SignatureError> {
    <[u8; 4]>::try_from(data)
        .map(u32::from_be_bytes)
        .map_err(|_| SignatureError::Malformed("a time subpacket that is not four octets"))
}

/// Find the key packet in `key.armored` whose fingerprint is `key.fingerprint`.
fn load_pinned_key(key: &TrustedKey) -> Result<PublicKey, SignatureError> {
    let fail = |reason| SignatureError::PinnedKey {
        fingerprint: key.fingerprint,
        reason,
    };
    let wanted = from_hex(key.fingerprint).ok_or(fail("the fingerprint is not 40 hex digits"))?;
    let block = dearmor(key.armored).ok_or(fail("not an armored public key block"))?;

    let mut rest = &block[..];
    while !rest.is_empty() {
        let (tag, body, tail) = next_packet(rest).map_err(fail)?;
        rest = tail;
        let is_key = matches!(tag, PUBLIC_KEY_TAG | PUBLIC_SUBKEY_TAG);
        if is_key && body.first() == Some(&4) && v4_fingerprint(body) == Some(wanted) {
            return parse_rsa_key(body, wanted).map_err(fail);
        }
    }
    Err(fail("no key in the block has that fingerprint"))
}

/// RFC 4880 §12.2: SHA-1 over the key packet body, framed as an old-format
/// packet with a two-octet length.
fn v4_fingerprint(body: &[u8]) -> Option<Fingerprint> {
    let len = u16::try_from(body.len()).ok()?;
    let mut ctx = digest::Context::new(&digest::SHA1_FOR_LEGACY_USE_ONLY);
    ctx.update(&[0x99]);
    ctx.update(&len.to_be_bytes());
    ctx.update(body);
    Fingerprint::try_from(ctx.finish().as_ref()).ok()
}

fn parse_rsa_key(body: &[u8], fingerprint: Fingerprint) -> Result<PublicKey, &'static str> {
    let mut r = Reader(body);
    r.u8()?; // version, already checked to be 4
    r.take(4)?; // creation time
    if r.u8()? != RSA_ALGORITHM {
        return Err("it is not an RSA key");
    }
    let n = r.mpi()?.to_vec();
    let e = r.mpi()?.to_vec();
    if !r.rest().is_empty() {
        return Err("trailing bytes in the key packet");
    }
    Ok(PublicKey { fingerprint, n, e })
}

/// Undo ASCII armor (RFC 4880 §6.2). Only ever applied to keys compiled into
/// Goop, so the armor checksum is not checked: the fingerprint pin already
/// covers every byte that matters.
fn dearmor(armored: &str) -> Option<Vec<u8>> {
    let mut lines = armored.lines().map(str::trim);
    lines.find(|line| *line == ARMOR_BEGIN)?;
    // Armor headers ("Comment: …") end at the first blank line.
    lines.find(|line| line.is_empty())?;
    let body: String = lines
        .take_while(|line| !line.starts_with('=') && !line.starts_with("-----"))
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// Split one packet off the front of `input`: its tag, its body, and what
/// follows it. Partial and indeterminate lengths never occur in a key or a
/// detached signature, so they are refused.
fn next_packet(input: &[u8]) -> Result<(u8, &[u8], &[u8]), &'static str> {
    let mut r = Reader(input);
    let ctb = r.u8()?;
    if ctb & 0x80 == 0 {
        return Err("not an OpenPGP packet");
    }
    let (tag, len) = if ctb & 0x40 != 0 {
        (ctb & 0x3F, r.new_format_len()?)
    } else {
        let len = match ctb & 0x03 {
            0 => usize::from(r.u8()?),
            1 => usize::from(r.u16()?),
            2 => r.u32_len()?,
            _ => return Err("an indeterminate packet length"),
        };
        ((ctb >> 2) & 0x0F, len)
    };
    let body = r.take(len)?;
    Ok((tag, body, r.rest()))
}

/// A cursor over untrusted bytes. Every read is bounds-checked, so a short
/// input is an error and never a panic.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    /// What has not been read yet.
    fn rest(&self) -> &'a [u8] {
        self.0
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let (head, tail) = self.0.split_at_checked(n).ok_or("truncated")?;
        self.0 = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, &'static str> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32_len(&mut self) -> Result<usize, &'static str> {
        let b = self.take(4)?;
        usize::try_from(u32::from_be_bytes([b[0], b[1], b[2], b[3]])).map_err(|_| "too long")
    }

    /// A new-format packet length (RFC 4880 §4.2.2), minus partial lengths.
    fn new_format_len(&mut self) -> Result<usize, &'static str> {
        match self.u8()? {
            first @ 0..=191 => Ok(usize::from(first)),
            first @ 192..=223 => {
                Ok(((usize::from(first) - 192) << 8) + usize::from(self.u8()?) + 192)
            }
            255 => self.u32_len(),
            _ => Err("a partial packet length"),
        }
    }

    /// A subpacket length (RFC 4880 §5.2.3.1). Same encoding as a new-format
    /// packet length, except that 224–254 are ordinary two-octet lengths.
    fn subpacket_len(&mut self) -> Result<usize, &'static str> {
        match self.u8()? {
            first @ 0..=191 => Ok(usize::from(first)),
            first @ 192..=254 => {
                Ok(((usize::from(first) - 192) << 8) + usize::from(self.u8()?) + 192)
            }
            255 => self.u32_len(),
        }
    }

    /// A multiprecision integer (RFC 4880 §3.2). Its bit count must describe
    /// its octets exactly; anything looser is not what an honest signer emits.
    fn mpi(&mut self) -> Result<&'a [u8], &'static str> {
        let bits = usize::from(self.u16()?);
        let value = self.take(bits.div_ceil(8))?;
        let actual = match value.first() {
            None => 0,
            Some(&top) => value.len() * 8 - top.leading_zeros() as usize,
        };
        if actual == bits {
            Ok(value)
        } else {
            Err("an MPI whose bit count does not match its value")
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            // Writing to a String cannot fail.
            let _ = write!(out, "{b:02X}");
            out
        })
}

fn from_hex(hex: &str) -> Option<Fingerprint> {
    if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = (0..20)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Fingerprint::try_from(bytes).ok()
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::TrustedKey;
    use std::path::Path;

    /// The throwaway key every signature fixture is made with.
    pub(crate) const TEST_KEY: TrustedKey = TrustedKey {
        fingerprint: "3AF4A28098BEFD0F20E9B3EDD6517E82BCCC23B0",
        armored: include_str!("../tests/fixtures/signatures/test-key.asc"),
    };

    /// The fingerprint of `other-key.asc`, which no test trusts.
    pub(crate) const OTHER_KEY_FINGERPRINT: &str = "EF2EC86A12818C439D478384AC9690709C7073E4";

    /// A file from `tests/fixtures/signatures`.
    pub(crate) fn fixture(name: &str) -> Vec<u8> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/signatures")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{fixture, OTHER_KEY_FINGERPRINT, TEST_KEY};
    use super::*;
    use std::time::Duration;

    fn verify(signature: &[u8]) -> Result<(), SignatureError> {
        verify_detached(
            &[TEST_KEY],
            &fixture("message.txt"),
            signature,
            SystemTime::now(),
        )
    }

    // ---- what the verifier accepts --------------------------------------

    #[test]
    fn accepts_a_good_signature() {
        assert_eq!(verify(&fixture("message.txt.sig")), Ok(()));
    }

    #[test]
    fn accepts_sha256_as_well_as_sha512() {
        assert_eq!(verify(&fixture("message.txt.sha256.sig")), Ok(()));
    }

    #[test]
    fn accepts_a_non_critical_subpacket_it_does_not_know() {
        assert_eq!(verify(&fixture("message.txt.notation.sig")), Ok(()));
    }

    /// Made 2026-01-01, expiring ten years later; checked against a fixed
    /// clock so the test does not start failing in 2036.
    #[test]
    fn accepts_a_signature_that_expires_later() {
        let mid_2026 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_000_000);
        let result = verify_detached(
            &[TEST_KEY],
            &fixture("message.txt"),
            &fixture("message.txt.expires-later.sig"),
            mid_2026,
        );
        assert_eq!(result, Ok(()));
    }

    /// How an upstream would roll over to a new key without breaking the
    /// releases already in the field: sign with both.
    #[test]
    fn accepts_a_file_signed_twice_when_either_signature_is_trusted() {
        let good = fixture("message.txt.sig");
        let untrusted = fixture("message.txt.other.sig");
        let ed25519 = fixture("message.txt.ed25519.sig");
        assert_eq!(verify(&[untrusted.clone(), good.clone()].concat()), Ok(()));
        assert_eq!(verify(&[good.clone(), untrusted].concat()), Ok(()));
        assert_eq!(verify(&[ed25519, good].concat()), Ok(()));
    }

    #[test]
    fn finds_the_signing_key_among_several_trusted_ones() {
        let other = TrustedKey {
            fingerprint: OTHER_KEY_FINGERPRINT,
            armored: include_str!("../tests/fixtures/signatures/other-key.asc"),
        };
        let result = verify_detached(
            &[other, TEST_KEY],
            &fixture("message.txt"),
            &fixture("message.txt.sig"),
            SystemTime::now(),
        );
        assert_eq!(result, Ok(()));
    }

    // ---- what it refuses ------------------------------------------------

    #[test]
    fn refuses_data_that_was_not_signed() {
        let mut data = fixture("message.txt");
        data[0] ^= 0x20;
        let result = verify_detached(
            &[TEST_KEY],
            &data,
            &fixture("message.txt.sig"),
            SystemTime::now(),
        );
        assert_eq!(result, Err(SignatureError::Mismatch));
    }

    /// A key rotation upstream looks exactly like this, and so does a
    /// forgery. Naming the key is what lets someone check it against the key
    /// upstream publishes.
    #[test]
    fn refuses_an_untrusted_key_and_names_it() {
        assert_eq!(
            verify(&fixture("message.txt.other.sig")),
            Err(SignatureError::UntrustedKey(OTHER_KEY_FINGERPRINT.into()))
        );
    }

    /// With several signatures and none good, a trusted key's "no" is the
    /// answer that matters, not the untrusted signature next to it.
    #[test]
    fn reports_the_trusted_keys_verdict_over_an_untrusted_signature() {
        let mut data = fixture("message.txt");
        data[0] ^= 0x20;
        let both = [fixture("message.txt.other.sig"), fixture("message.txt.sig")].concat();
        let result = verify_detached(&[TEST_KEY], &data, &both, SystemTime::now());
        assert_eq!(result, Err(SignatureError::Mismatch));

        let untrusted_twice = [
            fixture("message.txt.other.sig"),
            fixture("message.txt.other.sig"),
        ]
        .concat();
        assert_eq!(
            verify(&untrusted_twice),
            Err(SignatureError::UntrustedKey(OTHER_KEY_FINGERPRINT.into()))
        );
    }

    #[test]
    fn refuses_a_packet_that_is_not_a_signature() {
        let key = dearmor(TEST_KEY.armored).expect("test key dearmors");
        assert_eq!(
            verify(&[fixture("message.txt.sig"), key].concat()),
            Err(SignatureError::Malformed("not a signature packet"))
        );
    }

    #[test]
    fn refuses_when_nothing_is_trusted() {
        let result = verify_detached(
            &[],
            &fixture("message.txt"),
            &fixture("message.txt.sig"),
            SystemTime::now(),
        );
        assert_eq!(
            result,
            Err(SignatureError::UntrustedKey(TEST_KEY.fingerprint.into()))
        );
    }

    #[test]
    fn refuses_an_expired_signature() {
        assert_eq!(
            verify(&fixture("message.txt.expired.sig")),
            Err(SignatureError::Expired)
        );
    }

    /// The same signature is fine before its expiry, so the refusal above is
    /// about the clock and not the fixture.
    #[test]
    fn honours_the_expiry_against_the_clock_it_is_given() {
        let created = SystemTime::UNIX_EPOCH + Duration::from_secs(1_577_836_800);
        let result = verify_detached(
            &[TEST_KEY],
            &fixture("message.txt"),
            &fixture("message.txt.expired.sig"),
            created + Duration::from_secs(60),
        );
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn refuses_an_unknown_critical_subpacket() {
        assert!(matches!(
            verify(&fixture("message.txt.critical-notation.sig")),
            Err(SignatureError::Unsupported(_))
        ));
    }

    /// A text-mode signature hashes line endings differently. Neither upstream
    /// makes one, so accepting it would only widen what has to be right.
    #[test]
    fn refuses_a_text_mode_signature() {
        assert!(matches!(
            verify(&fixture("message.txt.text.sig")),
            Err(SignatureError::Unsupported(_))
        ));
    }

    #[test]
    fn refuses_sha1() {
        assert!(matches!(
            verify(&fixture("message.txt.sha1.sig")),
            Err(SignatureError::Unsupported(_))
        ));
    }

    #[test]
    fn refuses_a_non_rsa_signature() {
        assert!(matches!(
            verify(&fixture("message.txt.ed25519.sig")),
            Err(SignatureError::Unsupported(_))
        ));
    }

    #[test]
    fn refuses_an_armored_signature() {
        assert!(matches!(
            verify(&fixture("message.txt.asc")),
            Err(SignatureError::Malformed(_))
        ));
    }

    #[test]
    fn refuses_empty_truncated_and_padded_signatures() {
        let good = fixture("message.txt.sig");
        for len in 0..good.len() {
            assert!(
                matches!(verify(&good[..len]), Err(SignatureError::Malformed(_))),
                "a signature cut to {len} bytes must be malformed"
            );
        }
        let mut padded = good.clone();
        padded.push(0);
        assert!(matches!(verify(&padded), Err(SignatureError::Malformed(_))));
    }

    /// Every byte of the packet outside the unhashed subpackets is either
    /// signed or checked by the parser (framing, lengths, the digest prefix,
    /// the MPI's bit count), so flipping any of them must fail — and must
    /// never panic, since the signature file is attacker-supplied. The
    /// unhashed subpackets are not consulted at all, which this pins too.
    #[test]
    fn every_byte_outside_the_unhashed_area_is_load_bearing() {
        let good = fixture("message.txt.sig");
        // Old-format header with a two-octet length, then the v4 body.
        assert_eq!(good[0], 0x89, "fixture shape changed");
        let body = 3;
        let hashed_len = usize::from(u16::from_be_bytes([good[body + 4], good[body + 5]]));
        let unhashed_len_at = body + 6 + hashed_len;
        let unhashed_len = usize::from(u16::from_be_bytes([
            good[unhashed_len_at],
            good[unhashed_len_at + 1],
        ]));
        let unhashed = unhashed_len_at + 2..unhashed_len_at + 2 + unhashed_len;

        for i in 0..good.len() {
            for bit in [0x01, 0x80] {
                let mut flipped = good.clone();
                flipped[i] ^= bit;
                let result = verify(&flipped);
                if unhashed.contains(&i) {
                    assert_eq!(result, Ok(()), "unhashed byte {i} must not matter");
                } else {
                    assert!(result.is_err(), "flipping byte {i} by {bit:#04x} verified");
                }
            }
        }
    }

    // ---- framing the fixtures do not reach ------------------------------
    //
    // gpg writes old-format headers and one-octet subpacket lengths, so the
    // other encodings are pinned here directly. The packet-length examples
    // are RFC 4880 §4.2.3's own.

    #[test]
    fn reads_new_format_packet_lengths() {
        assert_eq!(Reader(&[0x64]).new_format_len(), Ok(100));
        assert_eq!(Reader(&[0xC0, 0x00]).new_format_len(), Ok(192));
        assert_eq!(Reader(&[0xC5, 0xFB]).new_format_len(), Ok(1723));
        assert_eq!(Reader(&[0xDF, 0xFF]).new_format_len(), Ok(8383));
        assert_eq!(
            Reader(&[0xFF, 0x00, 0x01, 0x86, 0xA0]).new_format_len(),
            Ok(100_000)
        );
        assert!(Reader(&[0xE0]).new_format_len().is_err(), "partial length");
        assert!(Reader(&[0xC5]).new_format_len().is_err(), "truncated");
    }

    #[test]
    fn reads_subpacket_lengths() {
        assert_eq!(Reader(&[0x64]).subpacket_len(), Ok(100));
        assert_eq!(Reader(&[0xC0, 0x00]).subpacket_len(), Ok(192));
        // Unlike a packet length, 224–254 is an ordinary two-octet form here.
        assert_eq!(Reader(&[0xE0, 0x00]).subpacket_len(), Ok(8384));
        assert_eq!(Reader(&[0xFE, 0xFF]).subpacket_len(), Ok(16_319));
        assert_eq!(
            Reader(&[0xFF, 0x00, 0x00, 0x20, 0xC0]).subpacket_len(),
            Ok(8384)
        );
        assert!(Reader(&[0xFF, 0x00, 0x00]).subpacket_len().is_err());
    }

    #[test]
    fn reads_old_and_new_format_packet_headers() {
        let packet = |input: &'static [u8]| next_packet(input);
        assert_eq!(packet(&[0x88, 0x01, 0xAA]), Ok((2, &[0xAA][..], &[][..])));
        assert_eq!(
            packet(&[0x8A, 0x00, 0x00, 0x00, 0x01, 0xAA, 0xBB]),
            Ok((2, &[0xAA][..], &[0xBB][..]))
        );
        assert_eq!(packet(&[0xC2, 0x01, 0xAA]), Ok((2, &[0xAA][..], &[][..])));
        assert!(packet(&[0x8B, 0xAA]).is_err(), "indeterminate length");
        assert!(packet(&[0x2D, 0x2D]).is_err(), "armor, not a packet");
    }

    #[test]
    fn refuses_signature_versions_other_than_4() {
        for version in [3, 5, 6] {
            assert!(matches!(
                parse_signature(&[version, 0x00, 0x01, 0x0A]),
                Err(SignatureError::Unsupported(_))
            ));
        }
    }

    #[test]
    fn hashed_subpackets_need_a_v4_issuer_and_a_creation_time() {
        let created = [5, SIG_CREATION_TIME, 0, 0, 0, 1];
        let issuer = |version: u8, len: usize| {
            let mut sub = vec![u8::try_from(len + 2).unwrap(), ISSUER_FINGERPRINT, version];
            sub.extend(std::iter::repeat_n(0xAB, len));
            sub
        };
        let parsed = |area: &[u8]| parse_hashed_subpackets(area).map(|f| f.issuer);

        assert_eq!(
            parsed(&[&created[..], &issuer(4, 20)].concat()),
            Ok([0xAB; 20])
        );
        // Critical is fine on a subpacket the verifier understands.
        let critical_created = [5, SIG_CREATION_TIME | CRITICAL, 0, 0, 0, 1];
        assert!(parsed(&[&critical_created[..], &issuer(4, 20)].concat()).is_ok());

        assert!(matches!(
            parsed(&created),
            Err(SignatureError::Unsupported(_))
        ));
        assert!(matches!(
            parsed(&[&created[..], &issuer(5, 32)].concat()),
            Err(SignatureError::Unsupported(_))
        ));
        assert!(matches!(
            parsed(&[&created[..], &issuer(4, 19)].concat()),
            Err(SignatureError::Malformed(_))
        ));
        assert!(matches!(
            parsed(&[&created[..], &issuer(4, 21)].concat()),
            Err(SignatureError::Malformed(_))
        ));
        assert_eq!(
            parsed(&issuer(4, 20)),
            Err(SignatureError::Malformed("no creation time"))
        );
        assert!(matches!(parsed(&[0x00]), Err(SignatureError::Malformed(_))));
    }

    // ---- the pinned key itself ------------------------------------------

    #[test]
    fn refuses_a_pinned_key_whose_fingerprint_does_not_match() {
        let mislabelled = TrustedKey {
            fingerprint: OTHER_KEY_FINGERPRINT,
            armored: TEST_KEY.armored,
        };
        let result = verify_detached(
            &[mislabelled],
            &fixture("message.txt"),
            &fixture("message.txt.sig"),
            SystemTime::now(),
        );
        assert!(matches!(result, Err(SignatureError::PinnedKey { .. })));
    }

    #[test]
    fn refuses_a_pinned_key_that_is_not_rsa() {
        let ed25519 = TrustedKey {
            fingerprint: "21AA5F28B9FA512C2096C2D242A0977C1C4DD25A",
            armored: include_str!("../tests/fixtures/signatures/ed25519-key.asc"),
        };
        let result = verify_detached(
            &[ed25519],
            &fixture("message.txt"),
            &fixture("message.txt.ed25519.sig"),
            SystemTime::now(),
        );
        assert!(matches!(result, Err(SignatureError::PinnedKey { .. })));
    }

    #[test]
    fn refuses_a_pinned_key_that_is_not_armored() {
        let garbage = TrustedKey {
            fingerprint: TEST_KEY.fingerprint,
            armored: "not a key",
        };
        let result = verify_detached(
            &[garbage],
            &fixture("message.txt"),
            &fixture("message.txt.sig"),
            SystemTime::now(),
        );
        assert!(matches!(result, Err(SignatureError::PinnedKey { .. })));
    }
}

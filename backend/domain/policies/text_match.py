"""Evidence text matching shared by qualification, filtering, and ranking."""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable

_ASCII_WORD = re.compile(r"[a-z0-9]+")
_CJK = re.compile(r"[\u3400-\u9fff]")


def text_matches_cue(text: str, cue: str) -> bool:
    """Match a cue without allowing ASCII tokens to hide inside other words.

    Search-provider titles often contain words such as ``distance`` or
    ``connection``. A raw substring search therefore treats the acronym
    ``ANC`` as observed evidence even though the product never claims active
    noise cancellation. ASCII cues use token boundaries; multi-token cues
    accept punctuation differences (``noise cancelling`` vs
    ``noise-cancelling``). CJK cues retain substring semantics because word
    boundaries are not represented by spaces.
    """
    haystack = unicodedata.normalize("NFKC", text or "").casefold()
    needle = unicodedata.normalize("NFKC", cue or "").strip().casefold()
    if not haystack or not needle:
        return False
    if _CJK.search(needle):
        return needle in haystack

    tokens = _ASCII_WORD.findall(needle)
    if not tokens:
        return needle in haystack
    if len(tokens) == 1:
        # Preserve meaningful trailing punctuation, e.g. the inch symbol in 27".
        pattern = re.escape(needle)
    else:
        pattern = r"[^a-z0-9]+".join(re.escape(token) for token in tokens)
    return re.search(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", haystack) is not None


def text_matches_any_cue(text: str, cues: Iterable[str]) -> bool:
    return any(text_matches_cue(text, str(cue)) for cue in cues if cue)


_MIC_ONLY_NOISE_CANCELLATION = (
    re.compile(
        r"\bnoise[^a-z0-9]+cancell?(?:ing|ation)?[^a-z0-9]+"
        r"(?:mic|microphone)s?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:mic|microphone)s?\b(?:[^a-z0-9]+[a-z0-9]+){0,3}"
        r"[^a-z0-9]+noise[^a-z0-9]+cancell?(?:ing|ation)?\b",
        re.IGNORECASE,
    ),
    re.compile(r"(?:麦克风|话筒)降噪|降噪(?:麦克风|话筒)"),
)


def text_matches_spec_cues(text: str, attr: str, cues: Iterable[str]) -> bool:
    """Match a specification while respecting attribute-specific semantics.

    A headset title that only advertises a noise-cancelling microphone is not
    evidence that the listening transducers provide noise cancellation.  The
    microphone phrase is removed before evaluating the ordinary evidence cues;
    an independent claim such as ``ANC`` still survives and can satisfy the
    gate.  Keeping this rule here makes filtering, qualification and ranking
    consume the same interpretation.
    """
    observed = text or ""
    if attr.casefold() == "noise_cancelling":
        for pattern in _MIC_ONLY_NOISE_CANCELLATION:
            observed = pattern.sub(" ", observed)
    return text_matches_any_cue(observed, cues)

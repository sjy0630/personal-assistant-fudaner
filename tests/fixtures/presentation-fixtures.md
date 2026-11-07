# PowerPoint import fixtures

`presentation-original.pptx` and `presentation-original.ppt` contain original,
redistributable test content authored for this repository. Both are real Impress
exports, including a binary PowerPoint 97–2003 compound file. They are not renamed
ZIPs or synthetic text records masquerading as Office documents.

The four slides contain Chinese/English/Latin-1 text and speaker notes, a 2×2 table,
an empty slide, and a slide containing only the one-pixel PNG. The PNG is generated
from the literal bytes in the script.

`generate-presentation.py` records the fixture-authoring process using LibreOffice's
bundled Python and UNO. It is never imported or launched by the application or its
tests. The committed binary fixtures make the test suite independent of Office,
LibreOffice and Python. The tests also append real MS-PPT save records to this
fixture to verify active-object resolution and exclusion of deleted/obsolete text.

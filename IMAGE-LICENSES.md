# Player pictures

Every athlete picture in `assets/players/` is a cut-out made from a photo on Wikimedia Commons by
`scripts/make_cutouts.py`: the photo is cropped to the head and neck and the background is removed, so no
shirt, crest or flag shows. Only photos under these licences are used:

- CC0 and public domain
- CC BY (any version)
- CC BY-SA (any version)

Photos under "non-commercial" (NC) or "no derivatives" (ND) terms are never used: ND forbids the editing the
cut-out needs.

For each picture the game stores the photographer, the licence and the Commons page, and shows them behind the
(i) on the picture and in the image credits at full time, with the note "edited: cropped, background removed".

A cut-out of a CC BY-SA photo is an adaptation, so it is shared under the same CC BY-SA licence as the original
(share-alike). Anyone may reuse those files on the same terms, crediting the photographer and noting the edit.
Cut-outs of CC BY photos are offered under CC BY, and of CC0 or public domain photos under CC0.

The face and the person are found with OpenCV's YuNet face detector and the U2-Net human segmentation model;
a CLIP model checks for national team shirts, flags and crests. All run locally when the files are built.
They are used only to find and cut out a face, never to identify anyone: who is in each photo comes from its
Commons description and structured data.

# Licences for the vendored fixtures

`table-page.pdf` is covered by the note in `../README.md` (arXiv
`nonexclusive-distrib/1.0`; page 1 of the same paper was already in this repo).
This file covers the **PubTabNet merged-cell fixture**, which has *two
independent rights holders* and therefore two licences:

| Artefact | Rights holder | Licence |
| --- | --- | --- |
| `pubtabnet-PMC5343394_003_00.gt.json` — the table annotation | IBM | **CDLA-Permissive-1.0** (full text below, per its §3.1(a)) |
| `pubtabnet-PMC5343394_003_00.png` — the table raster | The article's authors | **CC BY 4.0** (statement below) |

IBM's own `LICENSE.md` for PubTabNet states the split exactly
(<https://github.com/ibm-aur-nlp/PubTabNet/blob/master/LICENSE.md>):

> The annotations in this dataset belong to IBM and are licensed under a
> [Community Data License Agreement – Permissive – Version 1.0 License](https://cdla.io/permissive-1-0/).
>
> ## Images
> IBM does not own the copyright of the images. Use of the images must abide by
> the [PMC Open Access Subset Terms of Use](https://www.ncbi.nlm.nih.gov/pmc/tools/openftlist/).

Because PMC Open Access terms are **per article**, the corpus licence says
nothing about any individual image. The specific article was therefore checked
on its own before the raster was vendored, and only a CC BY article was
accepted. `fetch_pubtabnet_fixture.py` re-runs that check and refuses to write
the fixture if the article is not CC BY.

## 1. The image — PMC5343394, CC BY 4.0

- **PMC id:** PMC5343394
- **Citation:** BMC Res Notes. 2017 Mar 9; 10:122
- **Title:** *Knowledge and factors associated with pain management for
  hospitalized children among nurses working in public hospitals in Mekelle
  City, North Ethiopia: cross sectional study*
- **Table:** Table 3, "Knowledge on pain management among nurses for
  hospitalized children, Mekelle City, North Ethiopia, 2015"
- **NCBI OA service:** `license="CC BY"`
  (<https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=PMC5343394>)
- **Article:** <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5343394/>

The article's own licence statement, verbatim from the PMC article XML
(`<permissions>` block, retrieved via NCBI EFetch):

> © The Author(s) 2017
>
> **Open Access** This article is distributed under the terms of the Creative
> Commons Attribution 4.0 International License
> (<http://creativecommons.org/licenses/by/4.0/>), which permits unrestricted
> use, distribution, and reproduction in any medium, provided you give
> appropriate credit to the original author(s) and the source, provide a link to
> the Creative Commons license, and indicate if changes were made. The Creative
> Commons Public Domain Dedication waiver
> (<http://creativecommons.org/publicdomain/zero/1.0/>) applies to the data made
> available in this article, unless otherwise stated.

**Attribution, as CC BY requires:** the raster is Table 3 of the article above,
© The Author(s) 2017, used under CC BY 4.0.

**Changes made, as CC BY 4.0 §3(a)(1)(B) requires them to be indicated:** the
committed PNG is not the article's own figure file. It is PubTabNet's crop of
the table as published by IBM, retrieved through the Hugging Face
datasets-server, whose cached-assets CDN re-encoded it to JPEG; that JPEG was
then losslessly re-encoded to PNG. The frame (486×267) is unchanged and no
content was added, removed or retouched. Both hashes are recorded in the
`.gt.json` (`image.served_asset_sha256`, `image.sha256`) so the chain is
checkable end to end. See the "KNOWN PROVENANCE LIMITATION" section of
`../fetch_pubtabnet_fixture.py` for why the original PNG bytes were not used.

## 2. The annotation — IBM, CDLA-Permissive-1.0

The `html`, `grid`, `spans` and `cells` fields of
`pubtabnet-PMC5343394_003_00.gt.json` are PubTabNet annotation data.
`grid`/`spans`/`cells` are derived from `html` by
`fetch_pubtabnet_fixture.py::parse_gt`; that derivation is a **Modification**
in CDLA terms, and this paragraph is the §3.1(b) notice that the file has been
changed relative to what was Received.

Per **§3.1(a)** — the condition that applies when Publishing Received Data —
the full text of the Agreement is reproduced below. Per **§3.1(c)**, credit to
the Data Provider is preserved: the annotations are IBM's, from PubTabNet
(<https://github.com/ibm-aur-nlp/PubTabNet>).

### Row provenance

| Field | Value |
| --- | --- |
| Corpus | PubTabNet (IBM) |
| HF dataset | `nhhsag12/pubtabnet-with-html` (built from `ajimeno/PubTabNet`, per its `__url__` column) |
| Config / split / offset | `default` / `train` / **263** |
| Row key | `pubtabnet/train/PMC5343394_003_00` |
| Endpoint | `https://datasets-server.huggingface.co/rows` — per-row; no bulk download |
| Fetched | 2026-08-03 |

`ajimeno/PubTabNet` — the mirror the licence audit covered — exposes only the
image, with neither the HTML annotation nor a filename column, so it cannot on
its own supply the annotation or the PMC id needed for the check in §1.
`nhhsag12/pubtabnet-with-html` carries the image, the `__key__` (hence the PMC
id) and the annotation in a single row, and records `ajimeno/PubTabNet` as its
upstream. It declares no licence of its own; the licences that govern the data
are the two above, which flow from IBM and from the article, not from the
mirror.

---

## Community Data License Agreement – Permissive – Version 1.0 (full text)

Reproduced in full to satisfy §3.1(a). Canonical text:
<https://cdla.dev/permissive-1-0/> (SPDX id `CDLA-Permissive-1.0`).

```text
Community Data License Agreement – Permissive – Version 1.0

This is the Community Data License Agreement – Permissive, Version 1.0 (“Agreement”).  Data is provided to You under this Agreement by each of the Data Providers.  Your exercise of any of the rights and permissions granted below constitutes Your acceptance and agreement to be bound by the terms and conditions of this Agreement.

The benefits that each Data Provider receives from making Data available and that You receive from Data or otherwise under these terms and conditions shall be deemed sufficient consideration for the formation of this Agreement.  Accordingly, Data Provider(s) and You (the “Parties”) agree as follows:

Section 1.  Definitions

1.1 “Add” means to supplement Data with Your own or someone else’s Data, resulting in Your “Additions.”  Additions do not include Results.

1.2 “Computational Use” means Your analysis (through the use of computational devices or otherwise) or other interpretation of Data.  By way of example and not limitation, “Computational Use” includes the application of any computational analytical technique, the purpose of which is the analysis of any Data in digital form to generate information about Data such as patterns, trends, correlations, inferences, insights and attributes.

1.3 “Data” means the information (including copyrightable information, such as images or text), collectively or individually, whether created or gathered by a Data Provider or an Entity acting on its behalf, to which rights are granted under this Agreement.

1.4 “Data Provider” means any Entity (including any employee or contractor of such Entity authorized to Publish Data on behalf of such Entity) that Publishes Data under this Agreement prior to Your Receiving it.

1.5 “Enhanced Data” means the subset of Data that You Publish and that is composed of (a) Your Additions and/or (b) Modifications to Data You have received under this Agreement.

1.6 “Entity” means any natural person or organization that exists under the laws of the jurisdiction in which it is organized, together with all other entities that control, are controlled by, or are under common control with that entity.  For the purposes of this definition, “control” means (a) the power, directly or indirectly, to cause the direction or management of such entity, whether by contract or otherwise, (b) the ownership of more than fifty percent (50%) of the outstanding shares or securities, (c) the beneficial ownership of such entity or, (d) the ability to appoint, whether by agreement or right, the majority of directors of an Entity.

1.7 “Modify” means to delete, erase, correct or re-arrange Data, resulting in “Modifications.”  Modifications do not include Results.

1.8 “Publish” means to make all or a subset of Data (including Your Enhanced Data) available in any manner which enables its Use, including by providing a copy on physical media or remote access.  For any form of Entity, that is to make the Data available to any individual who is not employed by that Entity or engaged as a contractor or agent to perform work on that Entity’s behalf.  A “Publication” occurs each time You Publish Data.

1.9 “Receive” or “Receives” means to have been given access to Data, locally or remotely.

1.10 “Results” means the outcomes or outputs that You obtain from Your Computational Use of Data.  Results shall not include more than a de minimis portion of the Data on which the Computational Use is based.

1.11 “Sui Generis Database Rights” means rights, other than copyright, resulting from Directive 96/9/EC of the European Parliament and of the Council of 11 March 1996 on the legal protection of databases, as amended and/or succeeded, as well as other equivalent rights anywhere in the world.

1.12 “Use” means using Data (including accessing, copying, studying, reviewing, adapting, analyzing, evaluating, or making Computational Use of it), either by machines or humans, or a combination of both.

1.13 “You” or “Your” means any Entity that Receives Data under this Agreement.

Section 2.  Right and License to Use and to Publish

2.1 Subject to the conditions set forth in Section 3 of this Agreement, Data Provider(s) hereby grant(s) to You a worldwide, non-exclusive, irrevocable (except as provided in Section 5) right to: (a) Use Data; and (b) Publish Data.

2.2 To the extent that the Data or the coordination, selection or arrangement of Data is protected or protectable under copyright, Sui Generis Database Rights, or other law, Data Provider(s) further agree(s) that such Data or coordination, selection or arrangement is hereby licensed to You and to anyone else who Receives Data under this Agreement for Use and Publication, subject to the conditions set forth in Section 3 of this Agreement.

2.3 Except for these rights and licenses expressly granted, no other intellectual property rights are granted or should be implied.

Section 3.  Conditions on Rights Granted

3.1 If You Publish Data You Receive or Enhanced Data:

(a) You may do so under a license of Your choice provided that You give anyone who Receives the Data from You the text of this Agreement, the name of this Agreement and/or a hyperlink or other method reasonably likely to provide a copy of the text of this Agreement; and

(b) You must cause any Data files containing Enhanced Data to carry prominent notices that You have changed those files; and

(c) If You Publish Data You Receive, You must preserve all credit or attribution to the Data Provider(s). Such retained credit or attribution includes any of the following to the extent they exist in Data as You have Received it: legal notices or metadata; identification of the Data Provider(s); or hyperlinks to Data to the extent it is practical to do so.

3.2 You may provide additional or different license terms and conditions for use, reproduction, or distribution of that Enhanced Data, or for any combination of Data and Enhanced Data as a whole, provided that Your Use and Publication of that combined Data otherwise complies with the conditions stated in this License.

3.3 You and each Data Provider agree that Enhanced Data shall not be considered a work of joint authorship by virtue of its relationship to Data licensed under this Agreement and shall not require either any obligation of accounting to or the consent of any Data Provider.

3.4 This Agreement imposes no obligations or restrictions on Your Use or Publication of Results.

Section 4.  Data Provider(s)’ Representations

4.1 Each Data Provider represents that the Data Provider has exercised reasonable care, to assure that: (a) the Data it Publishes was created or generated by it or was obtained from others with the right to Publish the Data under this Agreement; and (b) Publication of such Data does not violate any privacy or confidentiality obligation undertaken by the Data Provider.

Section 5.  Termination

5.1 All of Your rights under this Agreement will terminate, and Your right to Receive, Use or Publish the Data will be revoked or modified if You materially fail to comply with the terms and conditions of this Agreement and You do not cure such failure in a reasonable period of time after becoming aware of such noncompliance.  If Your rights under this Agreement terminate, You agree to cease Receipt, Use and Publication of Data.  However, Your obligations and any rights and permissions granted by You under this Agreement relating to Data that You Published prior to such termination will continue and survive.

5.2 If You institute litigation against a Data Provider or anyone else who Receives the Data (including a cross-claim in a lawsuit) based on the Data, other than a claim asserting breach of this Agreement, then any rights previously granted to You to Receive, Use and Publish Data under this Agreement will terminate as of the date such litigation is filed.

Section 6.  Disclaimer of Warranties and Limitation of Liability

6.1 EXCEPT AS EXPRESSLY SET FORTH IN THIS AGREEMENT, THE DATA (INCLUDING ENHANCED DATA) IS PROVIDED ON AN “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED INCLUDING, WITHOUT LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE, NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

6.2 NEITHER YOU NOR ANY DATA PROVIDERS SHALL HAVE ANY LIABILITY FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING WITHOUT LIMITATION LOST PROFITS), HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OR DISTRIBUTION OF THE DATA OR THE EXERCISE OF ANY RIGHTS GRANTED HEREUNDER, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

Section 7.  Miscellaneous

7.1 You agree that it is solely Your responsibility to comply with all applicable laws with regard to Your Use or Publication of Data, including any applicable privacy, data protection, security and export laws.  You agree to take reasonable steps to assist a Data Provider fulfilling responsibilities to comply with applicable laws with regard to Use or Publication of Data Received hereunder.

7.2 You and Data Provider(s), collectively and individually, waive and/or agree not to assert, to the extent permitted by law, any moral rights You or they hold in Data.

7.3 This Agreement confers no rights or remedies upon any person or entity other than the Parties and their respective heirs, executors, successors and assigns.

7.4 The Data Provider(s) reserve no right or expectation of privacy, data protection or confidentiality in any Data that they Publish under this Agreement.  If You choose to Publish Data under this Agreement, You similarly do so with no reservation or expectation of any rights of privacy or confidentiality in that Data.

7.5 The Community Data License Agreement workgroup under The Linux Foundation is the steward of this Agreement (“Steward”).  No one other than the Steward has the right to modify or publish new versions of this Agreement.  Each version will be given a distinguishing version number.  You may Use and Publish Data Received hereunder under the terms of the version of the Agreement under which You originally Received the Data, or under the terms of any subsequent version published by the Steward.
```

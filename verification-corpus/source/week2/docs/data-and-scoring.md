# Data, execution, and scoring

## Public data

Public manifests pin `flwrlabs/celeba` at
`2d738f56e0e7f925ea36ae7c808ea925264aacec`. They select fixed rows, replace
identity values with opaque benchmark labels, and record hashes of the source
identity and decoded RGB pixels. Test and evaluation manifests are checked for
disjoint rows and identities.

The first local run streams only far enough to obtain selected rows and writes a
versioned user cache atomically. Later runs verify and reuse it. A partial,
wrong-revision, wrong-identity, or wrong-pixel cache never appears ready.
CelebA files are not redistributed and remain subject to the [CelebA agreement]
and [Hugging Face dataset terms].

The small public test uses 20 recognition inputs and 12 clustering inputs. The
public evaluation uses 72 recognition inputs and a 32-image clustering case.
Download and model setup time are reported separately from warm-cache runtime.

Every run receives the same CPU FaceNet model. `model-lock.json` pins the
`facenet_models` commit, scientific dependency versions, checkpoint size, and
SHA-256 digest. Official images bake that verified checkpoint before network is
disabled; local cache diagnostics apply the same lock.

## Official data

Official manifests and expected labels do not ship in this repository. Before a
benchmark version is activated, staff materialize approximately 144 recognition
images and three fixed clustering scenarios totaling approximately 96 images
into a private read-only evaluation volume. Its identities and rows must be
disjoint from both public manifests. The trusted controller sends only opaque
images and required enrollment labels to a network-disabled student sandbox.
Missing or corrupt official data is a provider failure and does not consume an
attempt.

## Metrics

Recognition reports macro known-person accuracy, unknown rejection recall, and
post-enrollment accuracy. `unknown_lifecycle` is the mean of the latter two;
`recognition_score` is the mean of known identification and that lifecycle.

Clustering's primary score is pairwise F1, averaged across fixed cases and
seeds. It is invariant to cluster-label names. Adjusted Rand index is diagnostic.

The portal derives Overall as:

```text
(known_identification + unknown_lifecycle + clustering_pairwise_f1) / 3
```

All three components are required. The two selected official track results must
refer to the same repository ID and commit SHA. Missing, malformed, skipped, or
wrong-length outputs are never removed from the denominator.

[CelebA agreement]: https://mmlab.ie.cuhk.edu.hk/projects/CelebA.html
[Hugging Face dataset terms]: https://huggingface.co/datasets/flwrlabs/celeba

---
license: other
license_name: celeba-dataset-release-agreement
license_link: LICENSE
dataset_info:
  config_name: img_align+identity+attr
  features:
  - name: image
    dtype: image
  - name: celeb_id
    dtype: int64
  - name: 5_o_Clock_Shadow
    dtype: bool
  - name: Arched_Eyebrows
    dtype: bool
  - name: Attractive
    dtype: bool
  - name: Bags_Under_Eyes
    dtype: bool
  - name: Bald
    dtype: bool
  - name: Bangs
    dtype: bool
  - name: Big_Lips
    dtype: bool
  - name: Big_Nose
    dtype: bool
  - name: Black_Hair
    dtype: bool
  - name: Blond_Hair
    dtype: bool
  - name: Blurry
    dtype: bool
  - name: Brown_Hair
    dtype: bool
  - name: Bushy_Eyebrows
    dtype: bool
  - name: Chubby
    dtype: bool
  - name: Double_Chin
    dtype: bool
  - name: Eyeglasses
    dtype: bool
  - name: Goatee
    dtype: bool
  - name: Gray_Hair
    dtype: bool
  - name: Heavy_Makeup
    dtype: bool
  - name: High_Cheekbones
    dtype: bool
  - name: Male
    dtype: bool
  - name: Mouth_Slightly_Open
    dtype: bool
  - name: Mustache
    dtype: bool
  - name: Narrow_Eyes
    dtype: bool
  - name: No_Beard
    dtype: bool
  - name: Oval_Face
    dtype: bool
  - name: Pale_Skin
    dtype: bool
  - name: Pointy_Nose
    dtype: bool
  - name: Receding_Hairline
    dtype: bool
  - name: Rosy_Cheeks
    dtype: bool
  - name: Sideburns
    dtype: bool
  - name: Smiling
    dtype: bool
  - name: Straight_Hair
    dtype: bool
  - name: Wavy_Hair
    dtype: bool
  - name: Wearing_Earrings
    dtype: bool
  - name: Wearing_Hat
    dtype: bool
  - name: Wearing_Lipstick
    dtype: bool
  - name: Wearing_Necklace
    dtype: bool
  - name: Wearing_Necktie
    dtype: bool
  - name: Young
    dtype: bool
  splits:
  - name: train
    num_bytes: 9333552813.19
    num_examples: 162770
  - name: valid
    num_bytes: 1138445362.203
    num_examples: 19867
  - name: test
    num_bytes: 1204311503.112
    num_examples: 19962
  download_size: 11734694689
  dataset_size: 11676309678.505001
configs:
- config_name: img_align+identity+attr
  data_files:
  - split: train
    path: img_align+identity+attr/train-*
  - split: valid
    path: img_align+identity+attr/valid-*
  - split: test
    path: img_align+identity+attr/test-*
  default: true
---

# Dataset Card for Dataset Name

CelebFaces Attributes Dataset (CelebA) is a large-scale face attributes dataset with more than 200K celebrity images, each with 40 attribute annotations. 
The images in this dataset cover large pose variations and background clutter. CelebA has large diversities, large quantities, and rich annotations, including:

* 10,177 number of identities,

* 202,599 number of face images, and

* 5 landmark locations, 40 binary attributes annotations per image.

The dataset can be employed as the training and test sets for the following computer vision tasks: face attribute recognition, face recognition, face detection, landmark (or facial part) localization, and face editing & synthesis.

This dataset is used in Federated Learning research because of the possibility of dividing it according to the identities of the celebrities. 
This repository enables us to use it in this context due to the existence of celebrity id (`celeb_id`) beside the images and attributes.

## Dataset Details
This dataset was created using the following data (all of which came from the original source of the dataset):
* aligned and cropped images (in PNG format),
* celebrities annotations,
* list attributes.

The dataset was divided according to the split specified by the authors (note the celebrities do not overlap between the splits).


### Dataset Sources 

- **Website:** https://liuziwei7.github.io/projects/FaceAttributes.html and https://mmlab.ie.cuhk.edu.hk/projects/CelebA.html
- **Paper:** [Deep Learning Face Attributes in the Wild](https://arxiv.org/abs/1411.7766)

## Uses

In order to prepare the dataset for the FL settings, we recommend using [Flower Dataset](https://flower.ai/docs/datasets/) (flwr-datasets) for the dataset download and partitioning and [Flower](https://flower.ai/docs/framework/) (flwr) for conducting FL experiments.

To partition the dataset, do the following. 
1. Install the package.
```bash
pip install flwr-datasets[vision]
```
2. Use the HF Dataset under the hood in Flower Datasets.
```python
from flwr_datasets import FederatedDataset
from flwr_datasets.partitioner import NaturalIdPartitioner

fds = FederatedDataset(
    dataset="flwrlabs/celeba",
    partitioners={"train": NaturalIdPartitioner(partition_by="celeb_id")}
)
partition = fds.load_partition(partition_id=0)
```

E.g., if you are following the LEAF paper, the target is the `Smiling` column.


## Dataset Structure
### Data Instances
The first instance of the train split is presented below:
```
{'image': <PIL.PngImagePlugin.PngImageFile image mode=RGB size=178x218>,
 'celeb_id': 1,
 '5_o_Clock_Shadow': True,
 'Arched_Eyebrows': False,
 'Attractive': False,
 'Bags_Under_Eyes': True,
 'Bald': False,
 'Bangs': False,
 'Big_Lips': False,
 'Big_Nose': False,
 'Black_Hair': False,
 'Blond_Hair': True,
 'Blurry': False,
 'Brown_Hair': True,
 'Bushy_Eyebrows': False,
 'Chubby': False,
 'Double_Chin': False,
 'Eyeglasses': False,
 'Goatee': False,
 'Gray_Hair': False,
 'Heavy_Makeup': False,
 'High_Cheekbones': True,
 'Male': True,
 'Mouth_Slightly_Open': True,
 'Mustache': False,
 'Narrow_Eyes': True,
 'No_Beard': True,
 'Oval_Face': False,
 'Pale_Skin': False,
 'Pointy_Nose': True,
 'Receding_Hairline': False,
 'Rosy_Cheeks': False,
 'Sideburns': False,
 'Smiling': True,
 'Straight_Hair': False,
 'Wavy_Hair': False,
 'Wearing_Earrings': False,
 'Wearing_Hat': False,
 'Wearing_Lipstick': False,
 'Wearing_Necklace': False,
 'Wearing_Necktie': False,
 'Young': False}
```

### Data Splits

```DatasetDict({
    train: Dataset({
        features: ['image', 'celeb_id', '5_o_Clock_Shadow', 'Arched_Eyebrows', 'Attractive', 'Bags_Under_Eyes', 'Bald', 'Bangs', 'Big_Lips', 'Big_Nose', 'Black_Hair', 'Blond_Hair', 'Blurry', 'Brown_Hair', 'Bushy_Eyebrows', 'Chubby', 'Double_Chin', 'Eyeglasses', 'Goatee', 'Gray_Hair', 'Heavy_Makeup', 'High_Cheekbones', 'Male', 'Mouth_Slightly_Open', 'Mustache', 'Narrow_Eyes', 'No_Beard', 'Oval_Face', 'Pale_Skin', 'Pointy_Nose', 'Receding_Hairline', 'Rosy_Cheeks', 'Sideburns', 'Smiling', 'Straight_Hair', 'Wavy_Hair', 'Wearing_Earrings', 'Wearing_Hat', 'Wearing_Lipstick', 'Wearing_Necklace', 'Wearing_Necktie', 'Young'],
        num_rows: 162770
    })
    valid: Dataset({
        features: ['image', 'celeb_id', '5_o_Clock_Shadow', 'Arched_Eyebrows', 'Attractive', 'Bags_Under_Eyes', 'Bald', 'Bangs', 'Big_Lips', 'Big_Nose', 'Black_Hair', 'Blond_Hair', 'Blurry', 'Brown_Hair', 'Bushy_Eyebrows', 'Chubby', 'Double_Chin', 'Eyeglasses', 'Goatee', 'Gray_Hair', 'Heavy_Makeup', 'High_Cheekbones', 'Male', 'Mouth_Slightly_Open', 'Mustache', 'Narrow_Eyes', 'No_Beard', 'Oval_Face', 'Pale_Skin', 'Pointy_Nose', 'Receding_Hairline', 'Rosy_Cheeks', 'Sideburns', 'Smiling', 'Straight_Hair', 'Wavy_Hair', 'Wearing_Earrings', 'Wearing_Hat', 'Wearing_Lipstick', 'Wearing_Necklace', 'Wearing_Necktie', 'Young'],
        num_rows: 19867
    })
    test: Dataset({
        features: ['image', 'celeb_id', '5_o_Clock_Shadow', 'Arched_Eyebrows', 'Attractive', 'Bags_Under_Eyes', 'Bald', 'Bangs', 'Big_Lips', 'Big_Nose', 'Black_Hair', 'Blond_Hair', 'Blurry', 'Brown_Hair', 'Bushy_Eyebrows', 'Chubby', 'Double_Chin', 'Eyeglasses', 'Goatee', 'Gray_Hair', 'Heavy_Makeup', 'High_Cheekbones', 'Male', 'Mouth_Slightly_Open', 'Mustache', 'Narrow_Eyes', 'No_Beard', 'Oval_Face', 'Pale_Skin', 'Pointy_Nose', 'Receding_Hairline', 'Rosy_Cheeks', 'Sideburns', 'Smiling', 'Straight_Hair', 'Wavy_Hair', 'Wearing_Earrings', 'Wearing_Hat', 'Wearing_Lipstick', 'Wearing_Necklace', 'Wearing_Necktie', 'Young'],
        num_rows: 19962
    })
})
```

## Citation 
When working with the CelebA dataset, please cite the original paper. 
If you're using this dataset with Flower Datasets and Flower, you can cite Flower.

**BibTeX:**
```
@inproceedings{liu2015faceattributes,
  title = {Deep Learning Face Attributes in the Wild},
  author = {Liu, Ziwei and Luo, Ping and Wang, Xiaogang and Tang, Xiaoou},
  booktitle = {Proceedings of International Conference on Computer Vision (ICCV)},
  month = {December},
  year = {2015} 
}
```
```
@article{DBLP:journals/corr/abs-2007-14390,
  author       = {Daniel J. Beutel and
                  Taner Topal and
                  Akhil Mathur and
                  Xinchi Qiu and
                  Titouan Parcollet and
                  Nicholas D. Lane},
  title        = {Flower: {A} Friendly Federated Learning Research Framework},
  journal      = {CoRR},
  volume       = {abs/2007.14390},
  year         = {2020},
  url          = {https://arxiv.org/abs/2007.14390},
  eprinttype    = {arXiv},
  eprint       = {2007.14390},
  timestamp    = {Mon, 03 Aug 2020 14:32:13 +0200},
  biburl       = {https://dblp.org/rec/journals/corr/abs-2007-14390.bib},
  bibsource    = {dblp computer science bibliography, https://dblp.org}
}
```


## Dataset Card Contact

For questions about the dataset, please contact Ziwei Liu and Ping Luo.
In case of any doubts about the dataset preparation, please contact [Flower Labs](https://flower.ai/).
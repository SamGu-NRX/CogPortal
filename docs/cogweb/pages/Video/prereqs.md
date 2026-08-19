---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python 3
    language: python
    name: python3
---

# Prerequisites


## Installs

Before we begin looking at all things visual, there are a few packages necessary to install in order to complete the exercises for this week.
As with the Audio module, it is strongly recommended that you [set up a new conda environment](https://www.pythonlikeyoumeanit.com/Module1_GettingStartedWithPython/Installing_Python.html#A-Brief-Introduction-to-Conda-Environments) with Python 3.7 or higher.
You can create a new conda environment with many of the needed packaged by running

If you are on **Windows or Linux**, run:

```
conda create -n week2 python=3.8 jupyter notebook numpy matplotlib xarray numba bottleneck scipy opencv scikit-learn scikit-image pytorch torchvision cpuonly -c pytorch -c conda-forge

```

If you are on **Mac OS** run:

```
conda create -n week2 python=3.8 jupyter notebook numpy matplotlib xarray numba bottleneck scipy opencv scikit-learn scikit-image pytorch torchvision -c pytorch -c conda-forge

```


Make sure to activate this conda environment by running

```
conda activate week2
```


Now we will install Once the new environment is activated, install [MyGrad](https://mygrad.readthedocs.io/en/latest/install.html), [MyNN](https://pypi.org/project/mynn/), [Noggin](https://noggin.readthedocs.io/en/latest/), and [Facenet](https://github.com/timesler/facenet-pytorch), and [cog_datasets](https://github.com/rsokl/cog_datasets), by running 

```
pip install mygrad mynn noggin facenet-pytorch cog-datasets
```

Once the new environment is activated, install

* the [Camera](https://github.com/cogworksbwsi/camera) package, following the installation instructions detailed on GitHub.
* the [Facenet-Models](https://github.com/CogWorksBWSI/facenet_models) package, following the installation instructions detailed on GitHub.


If you choose not to create a new conda environment, make sure that the following packages are properly installed:

* `jupyter`
* `notebook`
* `numpy`
* `matplotlib`
* `scipy`
* `opencv`, which must be [installed from the conda-forge channel](https://anaconda.org/conda-forge/opencv)
* `pytorch`, where specific installation instructions for your machine can be found [here](https://pytorch.org/)
* `mygrad`, which can be [installed via pip](https://mygrad.readthedocs.io/en/latest/install.html)
* `mynn`, which can be [installed via pip](https://github.com/davidmascharka/MyNN)
* `noggin`, which can be [installed via pip](https://noggin.readthedocs.io/en/latest/install.html#installing-noggin)
* `facenet-pytorch`, which can be [installed via pip](https://github.com/timesler/facenet-pytorch)
* [cog_datasets](https://github.com/rsokl/cog_datasets)
* [Camera](https://github.com/cogworksbwsi/camera)
* [Facenet-Models](https://github.com/CogWorksBWSI/facenet_models)


## Math Supplements

Before continuing in this module, it will be important to have a good understanding of the following materials:

* [Fundamentals of Linear Algebra](https://rsokl.github.io/CogWeb/Math_Materials/LinearAlgebra.html)
* [Introduction to Single-Variable Calculus](https://rsokl.github.io/CogWeb/Math_Materials/Intro_Calc.html)
* [Multivariable Calculus: Partial Derivatives & Gradients](https://rsokl.github.io/CogWeb/Math_Materials/Multivariable_Calculus.html)
* [Chain Rule](https://rsokl.github.io/CogWeb/Math_Materials/Chain_Rule.html)

It is strongly recommended reading through these sections and completing the reading comprehension questions before proceeding.

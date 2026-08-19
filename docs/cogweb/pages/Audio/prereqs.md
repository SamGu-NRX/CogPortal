---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python [conda env:cogweb] *
    language: python
    name: conda-env-cogweb-py
---

# Prerequisites


## Installs

Before we begin hearing about all things audio, there are a few packages that you will need to install to complete the exercises for this week.
It is strongly recommended that you [set up a new conda environment](https://www.pythonlikeyoumeanit.com/Module1_GettingStartedWithPython/Installing_Python.html#A-Brief-Introduction-to-Conda-Environments) with Python 3.7 or higher.
You can create a new conda environment with many of the needed packaged by running

```
conda create -n week1 python=3.8 ipython jupyter notebook numpy scipy matplotlib pyaudio numba
```

```
conda install -n week1 -c conda-forge librosa ffmpeg
```

Make sure to activate this conda environment by running

```
conda activate week1
```

Once the new environment is activated, install

* the [Microphone](https://github.com/CogWorksBWSI/Microphone) package, following the installation instructions detailed on GitHub.
* [MyGrad](https://mygrad.readthedocs.io/en/latest/install.html), by running `pip install mygrad`


If you choose not to create a new conda environment, make sure that the following packages are properly installed:

* `ipython`
* `jupyter`
* `notebook`
* `numpy`
* `scipy`
* `matplotlib`
* `numba`
* `librosa` and `ffmpeg`, which must be [installed from the conda-forge channel](https://librosa.github.io/librosa/install.html#conda)
* [Microphone](https://github.com/CogWorksBWSI/Microphone)
* `mygrad`, which can be [installed via pip](https://mygrad.readthedocs.io/en/latest/install.html)


## Math Supplements

Before continuing in this module, it will be important to have a good understanding of the following material:

* [Functions](https://rsokl.github.io/CogWeb/Math_Materials/Functions.html)
* [Sequences and Summations](https://rsokl.github.io/CogWeb/Math_Materials/Series.html)
* [Complex Numbers](https://rsokl.github.io/CogWeb/Math_Materials/ComplexNumbers.html)

Note that, while the **Complex Numbers** references material in the **Fundamentals of Linear Algebra** section due to parallels in the material, the Audio module only requires knowledge of content presented in the sections listed above.

It is strongly recommended reading through these sections and completing the reading comprehension questions before proceeding.

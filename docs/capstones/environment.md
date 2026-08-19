# Student environment (CogWeb ground truth)

> Verbatim CogWeb course material, captured for reference. Do not edit to fit our
> design; re-capture from the source instead.

**Fetched:** 2026-08-16

**Sources:**

- [pre_reqs.html — Course Pre-Requisites](https://rsokl.github.io/CogWeb/pre_reqs.html)
- [Audio/prereqs.html — Prerequisites (week 1)](https://rsokl.github.io/CogWeb/Audio/prereqs.html)
- [Video/prereqs.html — Prerequisites (week 2)](https://rsokl.github.io/CogWeb/Video/prereqs.html)
- [Language/prereqs.html — Prerequisites (week 3)](https://rsokl.github.io/CogWeb/Language/prereqs.html)
- [PLYMI — Installing Python via Anaconda](https://www.pythonlikeyoumeanit.com/Module1_GettingStartedWithPython/Installing_Python.html)
  (external; CogWeb delegates the base install to this page rather than restating it)

These four CogWeb pages are the only places the course states what a student has
installed. Anything the platform assumes about a student's machine has to trace back
to one of them.

---

## Derived index (ours, not course text)

The rest of this file is verbatim; this table is the one thing we wrote, kept here so
the environment facts are greppable. Every cell restates a line from a section below.

| | Week 1 (Audio) | Week 2 (Vision) | Week 3 (Language) |
|---|---|---|---|
| conda env name | `week1` | `week2` | `week3` |
| Python | `python=3.8` | `python=3.8` | `python=3.8` |
| conda channels | default, then `conda-forge` | `-c pytorch -c conda-forge` | default, `conda-forge`, `pytorch` |
| conda packages | ipython, jupyter, notebook, numpy, scipy, matplotlib, pyaudio, numba, librosa, ffmpeg | jupyter, notebook, numpy, matplotlib, xarray, numba, bottleneck, scipy, opencv, scikit-learn, scikit-image, pytorch, torchvision (`cpuonly` on Windows/Linux) | jupyter, notebook, numpy, matplotlib, numba, scikit-learn, `nltk=3.6.5`, python-graphviz, pytorch, torchvision (`cpuonly` on Windows/Linux) |
| pip packages | `mygrad` | `mygrad mynn noggin facenet-pytorch cog-datasets` | `mygrad mynn noggin gensim cogworks-data` |
| CogWorks GitHub packages | [Microphone](https://github.com/CogWorksBWSI/Microphone) | [Camera](https://github.com/CogWorksBWSI/Camera), [facenet_models](https://github.com/CogWorksBWSI/facenet_models) | none |
| platform split in the course text | none | yes: Mac OS omits `cpuonly` | yes: Mac OS omits `cpuonly` |

Two notes the table can't carry:

- The prereq pages say "Python 3.7 or higher" in prose while every `conda create`
  command pins `python=3.8`. The command is the operative one.
- The week 2 capstone and the Whispers page each add a package *after* the prereq
  page: `conda install -c conda-forge scikit-image` (already in the week 2 create
  command) and `conda install -c conda-forge networkx` (not in any create command,
  so a student following only the prereq page does not have `networkx`).

---

## Course Pre-Requisites

Source: <https://rsokl.github.io/CogWeb/pre_reqs.html>

This course was designed for advanced high school students who have a keen interest in the STEM fields

It is beneficial for students to have previous experience programming.
This course is not designed to serve as an introduction to programming.
That being said, **students are expected to have completed modules 1 - 5 of** [Python Like You Mean It (PLYMI)](https://www.pythonlikeyoumeanit.com/),
**and to to have followed carefully the instructions for** [installing Python via Anaconda](https://www.pythonlikeyoumeanit.com/Module1_GettingStartedWithPython/Installing_Python.html).
It is eminently important that students are comfortable with the topics covered in PLYMI.

Students are expected to have strong skills in mathematics.
They will need to work with functions of multiple variables and have a keen ability
to think visually about functions and mappings.
Experience in trigonometry and pre-calculus is necessary.
It is not necessary for students to have taken calculus or linear algebra,
but some of these concepts will be used.
Past CogWorks students did not have calculus and linear algebra experience,
and completed this course with great success; it did require them to put in some extra
individual effort to understand these concepts.

Interest, enthusiasm, and an attention for detail are all a must!

---

## Week 1 (Audio) prerequisites

Source: <https://rsokl.github.io/CogWeb/Audio/prereqs.html>

#### Installs

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


#### Math Supplements

Before continuing in this module, it will be important to have a good understanding of the following material:

* [Functions](https://rsokl.github.io/CogWeb/Math_Materials/Functions.html)
* [Sequences and Summations](https://rsokl.github.io/CogWeb/Math_Materials/Series.html)
* [Complex Numbers](https://rsokl.github.io/CogWeb/Math_Materials/ComplexNumbers.html)

Note that, while the **Complex Numbers** references material in the **Fundamentals of Linear Algebra** section due to parallels in the material, the Audio module only requires knowledge of content presented in the sections listed above.

It is strongly recommended reading through these sections and completing the reading comprehension questions before proceeding.

---

## Week 2 (Vision) prerequisites

Source: <https://rsokl.github.io/CogWeb/Video/prereqs.html>

#### Installs

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


#### Math Supplements

Before continuing in this module, it will be important to have a good understanding of the following materials:

* [Fundamentals of Linear Algebra](https://rsokl.github.io/CogWeb/Math_Materials/LinearAlgebra.html)
* [Introduction to Single-Variable Calculus](https://rsokl.github.io/CogWeb/Math_Materials/Intro_Calc.html)
* [Multivariable Calculus: Partial Derivatives & Gradients](https://rsokl.github.io/CogWeb/Math_Materials/Multivariable_Calculus.html)
* [Chain Rule](https://rsokl.github.io/CogWeb/Math_Materials/Chain_Rule.html)

It is strongly recommended reading through these sections and completing the reading comprehension questions before proceeding.

---

## Week 3 (Language) prerequisites

Source: <https://rsokl.github.io/CogWeb/Language/prereqs.html>

#### Installs

Before we begin reading about at all things language, there are a few packages that will be needed throughout the module.
As with the previous two modules, it is strongly recommended that you [set up a new conda environment](https://www.pythonlikeyoumeanit.com/Module1_GettingStartedWithPython/Installing_Python.html#A-Brief-Introduction-to-Conda-Environments) with Python 3.7 or higher.
You can create a new conda environment with many of the needed packaged by running
```
conda create -n week3 python=3.8 jupyter notebook numpy matplotlib numba scikit-learn nltk=3.6.5
```
```
conda install -n week3 -c conda-forge python-graphviz
```

We will need PyTorch as well. If on Windows or Linux, run
```
conda install -n week3 pytorch torchvision cpuonly -c pytorch
```

If on MacOS, run
```
conda install -n week3 pytorch torchvision -c pytorch
```

Make sure to activate this conda environment by running
```
conda activate week3
```

Once the new environment is activated, install

* [MyGrad](https://mygrad.readthedocs.io/en/latest/install.html), [MyNN](https://pypi.org/project/mynn/), [Noggin](https://noggin.readthedocs.io/en/latest/), and [Gensim](https://pypi.org/project/gensim/), by running:
 
```
pip install mygrad mynn noggin gensim cogworks-data
```


If you choose not to create a new conda environment, make sure that the following packages are properly installed:

* `jupyter`
* `notebook`
* `numpy`
* `matplotlib`
* `numba`
* `scikit-learn`
* `nltk`, make sure to install v.3.6.5, as newer versions introduce performance issues.
* `python-graphviz`, which should be [installed via the conda-forge channel](https://anaconda.org/conda-forge/python-graphviz)
* `pytorch`, where specific installation instructions for your machine can be found [here](https://pytorch.org/)
* `mygrad`, which can be [installed via pip](https://mygrad.readthedocs.io/en/latest/install.html)
* `mynn`, which can be [installed via pip](https://pypi.org/project/mynn/)
* `noggin`, which can be [installed via pip](https://noggin.readthedocs.io/en/latest/install.html#installing-noggin)
* `gensim`, which must be [installed via pip](https://pypi.org/project/gensim/)


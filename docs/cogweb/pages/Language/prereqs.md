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

---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.7
  nbsphinx:
    execute: never
---

# Notebook of Failure 

(aka "Even Odd Problem with Feed Forward Networks")

In this notebook, we'll attempt to solve the following problem: Given an input vector of zeros and ones, predict `1` if the number of ones in the vector is even, and predict `0` if the number of ones in the vector is odd.

Sounds easy enough, right? :)


## Imports

```python
import mygrad as mg
import numpy as np
import matplotlib.pyplot as plt

%matplotlib notebook
```

<!-- #region -->
## Create even/odd dataset

Create a function that returns numpy arrays `x` and `y`, where:
* `x` is an NumPy array of shape $(N, T)$ where each element is 0 or 1 with equal probability
* `y` is an NumPy array of shape $(N,)$ where $y_i$ is 1 if number of 1s in row $i$ is even and 0 otherwise

$N$ is the size of our batch and $T$ is the length of each vector of zeros and ones.

For example, `generate_dataset(4, 8)` produces four vectors, each containing a length-8 sequence of zeros and ones. For `x`, it might produce:
```python
[[1. 0. 1. 1. 0. 1. 1. 1.]
 [0. 1. 1. 1. 0. 1. 0. 1.]
 [0. 1. 0. 1. 0. 1. 0. 0.]
 [0. 1. 1. 0. 0. 1. 1. 1.]]
```

Then the corresponding truth, `y`, would be:

```python
[1 0 0 0]
```
Note that `y` needs to have dtype `np.int` to be used with MyGrad/MyNN cross entropy loss.

Also note that it's possible for rows to appear more than once, but this gets less and less probable as the the number of columns increases.
<!-- #endregion -->

```python
def generate_dataset(N, T):
    """
    Parameters
    ----------
    N : int
        The number of even/odd sequences to generate
        
    T : int
        The length of each even/odd sequence
    
    Returns
    -------
    Tuple[numpy.ndarray, numpy.ndarray], shapes=(N, T) & (T,)
        A tuple containing:
            - the batch of even/odd sequences; shape-(N, T)
            - the integer label for each sequence: 1 if even, 0 if odd; shape-(N,)
        """
    # <COGINST>
    x = np.random.choice([0, 1], (N, T)).astype(np.float_)
    y = (x.sum(axis=1) % 2 == 0).astype(np.int_)
    return x, y
    # </COGINST>
```

Test your `generate_dataset`. Generate four sequences, each sequence being length-8. Manually tally each sequence and verify that each label is correct for the even/oddness of each sequence.

```python
# <COGINST>
x, y = generate_dataset(4, 8)
print(x)
print(y)
# </COGINST>
```

Now generate a dataset with 10000 rows and 32 columns, and split the data/labels evenly into train and test.

```python
# <COGINST>
x, y = generate_dataset(10000, 32)
num_train = int(len(y) * 0.5)
xtrain = x[:num_train,:]
ytrain = y[:num_train]
xtest = x[num_train:,:]
ytest = y[num_train:]
# </COGINST>
```

Print out the shapes of your train/test sequence-data/labels to verify that they match with your expectations.

```python
# <COGINST>
print(xtrain.shape, ytrain.shape)
xtrain[0,:], ytrain[0] # look at one training example sequence and corresponding label
# </COGINST>
```

## Define MyNN model

Initially try using a two-layer neural network (one hidden layer of ReLU units):

\begin{equation}
f(W_{1}, W_{2}, b_{1}, b_{2};\;X) = \mathrm{softmax}(\mathrm{ReLU}(XW_{1} + b_{1})W_{2} + b_{2})
\end{equation}

with cross entropy loss.

For convenience, use MyGrad's `softmax_crossentropy` loss. This means that the MyNN model doesn't need to apply the softmax activation in its forward pass (because `softmax_crossentropy` will do it for us), i.e.,

\begin{equation}
f(W_{1}, W_{2}, b_{1}, b_{2};\;X) = \mathrm{ReLU}(XW_{1} + b_{1})W_{2} + b_{2}
\end{equation}

Ultimately, we will have our neural network produce **two** classification scores: $p_{odd}$ and $p_{even}$

Use `from mygrad.nnet.initializers import normal`, and specify `normal` as the weight initializer for your dense layers. A layer size of 100 for your first layer, $W_{1}$, is a reasonable start.

```python
from mynn.layers.dense import dense
from mynn.optimizers.sgd import SGD

from mygrad.nnet.activations import relu
from mygrad.nnet.initializers import normal
from mygrad.nnet.losses import softmax_crossentropy

# Define your MyNN-model


class Model:
    def __init__(self, dim_in, num_hidden, dim_out):
        # <COGINST>
        self.dense1 = dense(dim_in, num_hidden, weight_initializer=normal)
        self.dense2 = dense(num_hidden, dim_out, weight_initializer=normal)
        # </COGINST>

    def __call__(self, x):
        """ The model's forward pass functionality.
        
        Parameters
        ----------
        x : Union[numpy.ndarray, mygrad.Tensor], shape=(N, T)
            The batch of size-N.
            
        Returns
        -------
        mygrad.Tensor, shape=(N, 2)
            The model's predictions for each of the N pieces of data in the batch.
        """
        # <COGINST>
        return self.dense2(relu(self.dense1(x)))
        # </COGINST>

    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model. """
        # <COGINST>
        return self.dense1.parameters + self.dense2.parameters
        # </COGINST>
```

Now initialize model and optimizer. Try using 100 units in hidden layer. For your optimizer, try the SGD with a `learning_rate` of 0.1.

```python
# <COGINST>
num_hidden = 100
model = Model(32, num_hidden, 2)
optim = SGD(model.parameters, learning_rate=0.1)
# </COGINST>
```

Now, create an accuracy function to compare your predictions to your labels.

```python
def accuracy(predictions, truth):
    """
    Returns the mean classification accuracy for a batch of predictions.
    
    Parameters
    ----------
    predictions : Union[numpy.ndarray, mg.Tensor], shape=(N, 2)
        The scores for 2 classes, for a batch of N data points
        
    truth : numpy.ndarray, shape=(N,)
        The true labels for each datum in the batch: each label is an
        integer in [0, 1]
    
    Returns
    -------
    float
    """
    return np.mean(np.argmax(predictions, axis=1) == truth) # <COGLINE>
```

Now set up a noggin plot.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(metrics=["loss", "accuracy"])
```

Time to train your model!. You can try setting `batch_size = 100` and training for 700 epochs.

```python
# <COGINST>
batch_size = 100
num_epochs = 700
# </COGINST>

for epoch_cnt in range(num_epochs):
    idxs = np.arange(len(xtrain))
    np.random.shuffle(idxs)  
    
    for batch_cnt in range(0, len(xtrain) // batch_size):
        # random batch of our training data
        # <COGINST>
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]
        batch = xtrain[batch_indices]
        truth = ytrain[batch_indices]
        # </COGINST>

        # perform the forward pass on our batch
        prediction = model(batch) # <COGLINE>
        
        # calculate the loss
        loss = softmax_crossentropy(prediction, truth) # <COGLINE>
        
        # perform backpropagation
        loss.backward() # <COGLINE>
        
        # update your parameters
        optim.step() # <COGLINE>
        
        # calculate the accuracy
        acc = accuracy(prediction, truth) # <COGLINE>
        
        plotter.set_train_batch({"loss" : loss.item(), "accuracy" : acc}, batch_size=batch_size)
    
    for batch_cnt in range(0, len(xtest) // batch_size):
        idxs = np.arange(len(xtest))
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]
        batch = xtest[batch_indices]
        truth = ytest[batch_indices]
        
        with mg.no_autodiff:
            prediction = model(batch)
            acc = accuracy(prediction, truth)
        
        plotter.set_test_batch({"accuracy" : acc}, batch_size=batch_size)
    
    plotter.set_train_epoch()
    plotter.set_test_epoch()  
```

Inspect the final train and test accuracy of your model.

```python
accuracy(model(xtrain), ytrain), accuracy(model(xtest), ytest) # <COGLINE>
```

Considering these accuracies, was the network successful or an utter failure?

When using the suggested initial setup, it looks like this model is essentially memorizing the training set while learning absolutely nothing that's generalizable. Why do you think this is such a hard problem for this typical neural network architecture to learn? Would dropout on the input layer help? Could convolutions help? Discuss with your neighbors!

Now try experimenting with training set size, number of columns in data, number of layers, layer sizes, activations functions, regularization (weight_decay), optimizer, etc. to try to improve performance on test set.

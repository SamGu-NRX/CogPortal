---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  nbsphinx:
    execute: never
---

```python
import mygrad as mg

from cog_datasets import ToyData
import numpy as np

import matplotlib.pyplot as plt

%matplotlib notebook
```

In this notebook, we will be training a two-layer neural network to solve a *classification* problem on a toy data set. We will generate a spiral-formation of 2D data points. This spiral will have grouped "tendrils", and we will want our neural network to classify *to which tendril a given point belongs*. 

Read the documentation for `ToyData`. Run the following cells to view the spiral data set.

```python
# Constructing the spiral dataset and its labels.
num_tendril = 3
data = ToyData(num_classes=num_tendril)

# Loads training data and labels as numpy arrays
xtrain, ytrain, _, _ = data.load_data()

xtrain.shape, ytrain.shape
```

```python
fig, ax = data.plot_spiraldata()
```

- red: label-0
- yellow: label-1
- blue: label-2


Print out the contents of `xtrain` and `ytrain`. What do these arrays correspond to? See that `xtrain` stores the 2D data points in the spiral, and `ytrain` stores the Tendril-ID associated with that point. How many points are in our training data? How are the labels specified for this dataset? Discuss with your neighbor.


## Our Model

We will extend the universal function approximation function to make a *classification* prediction. That is, given a shape-(2,) point $\vec{x} = [x_o, y_o]$, our model will produce a shape-(3,) vector $\vec{y}_{pred} = [y_0, y_1, y_2]$, where the $i$-th element, $y_i$, indicates how "confident" our model is that the point located at $\vec{x}$ belongs to tendril-$i$. 

\begin{equation}
F(\{\vec{v}_i\}, \{\vec{w}_i\}, \{b_i\}; \vec{x}) = \sum_{i=1}^{N} \vec{v}_{i}\varphi(\vec{x} \cdot \vec{w}_{i} + b_{i}) = \vec{y}_{pred}
\end{equation}

Notice here that $\vec{v}_i$ is now a *vector*, whereas in the original universal function approximation theorem it was a scalar. This is in accordance with the fact that we now want to *predict* a vector, $\vec{y}_{pred}$, instead of a single number $y_{pred}$.

Given that $\varphi(\vec{x} \cdot \vec{w}_{i} + b_{i})$ is a scalar, each $\vec{v}_i$ should have shape-(3,) such that $\vec{y}_{pred}$ contains a total of classification score predictions – one per tendril.


In this notebook, we will create a single-layer dense neural network that closely resembles the approximator that we created to fit $\cos{(x)}$.
This time, however, $\vec{x}$ will be a 2D point instead of a single number. Thus a batch of our training data will have a shape $(M, 2)$ instead of $(M, 1)$, where $M$ is the size of our batch. 


Because we are classifying which of three tendrils a 2D point belongs to, we now **want our model to predict *three* numbers** ($\vec{y}_{pred} = [y_0, y_1, y_2]$), rather than one, as its prediction.
These three numbers will be the three "scores" that our model predicts for a point: one for each tendril. If score-0 is the largest score, then our model is predicting that the 2D point belongs to tendril 0. And so on.
Thus, given batch of shape-$(M, 2)$, our model will produce a shape-$(M, 3)$ tensor as its prediction; for each of the $M$ 2D input points, the model will produce $3$ classification scores. 


## The "Activation" Function

We will be using the so-called "activation function" known as a "rectified linear unit", or ReLU for short:

\begin{equation}
\varphi_{\text{relu}}(x) = 
\begin{cases} 
      0, \quad x < 0 \\
      x, \quad 0 \leq x
\end{cases}
\end{equation}

This is a very popular activation function in the world of deep learning. We will not have time to go into why here, but it is worthwhile to read about. `mygrad` has this function: `mygrad.nnet.activations.relu`.


Here we will import  the relu function from `mygrad`, and plot it on $x \in [-3, 3]$. We will plot its derivative as well.

```python
from mygrad.nnet.activations import relu
```

```python
import mygrad as mg

fig, ax = plt.subplots()
x = mg.linspace(-3, 3, 1000)

ax.grid(True)

f = relu(x)
ax.plot(x, f, label="relu")

f.backward()

ax.plot(x, x.grad, label="derivative")
ax.legend();
```

<!-- #region -->

### Initializing Our Model Parameters

### Model Parameter Shapes

Refer back to the linear regression model that we created before, and specifically note the shapes of the different model parameter tensors that we initialized.
In the linear regression problem we effectively treated each datum and output as a shape-(1,) vector.
Now we are working with shape-(2,) vectors as inputs and shape-(3,) vectors as outputs.
Given this context, what must the respective lengths of each $\vec{w}_i$ and $\vec{v}_i$ be?

<COGINST>
Given that each datum $\vec{x}$ is shape-(2,) then each $\vec{w}_i$ must also be shape-(2,).
The shape of $\vec{v}_i$ determines and matches the shape of our model's output, thus it must be shape-(3,).
</COGINST>

As was eluded to in the previous exercise notebook, we don't need to change any of the math of the "forward pass" of our model; it is once again:


```python
relu_out = relu(np.matmul(x, model.w) + model.b)
out = np.matmul(relu_out, model.v)
```

Based on this, what are the shapes of:
- `x` (a batch of data)
- `model.w`
- `model.b`
- `model.v`
- `out`

<COGINST>

```
x w + b --> matmul[(M,2) w/ (2, N)] + (N,) --> (M, N)
v relu(x w + b) --> matmul[(M, N) w/ (N, num_tendril)] --> (M, num_tendril)
```

- `x`: `(M, 2)`  (where M is batch-size)
- `model.w`: `(2, N)`  (where N is the number of neurons in this layer of our model)
- `model.b`: `(N,)`
- `model.v`: `(N, num_tendrils)` (where `num_tendrils` is the number of possible classes that we are predicting among)
- `out`: `(M, num_tendrils)

</COGINST>

Check your answers with TAs / neighbors before proceeding.

### Drawing Initial Values from Random Distributions

We will be using a initialization technique known as "He-normal" initialization (pronounced "hey"). Essentially we will draw all of our dense-layer parameters from a scaled normal distribution, where the distribution will scaled by an additional $\frac{1}{\sqrt{2N}}$, where $N$ is dictates that number of parameters among $\{\vec{v}_i\}_{i=1}^{N}$, $\{\vec{w}_i\}_{i=1}^{N}$, and $\{b_i\}_{i=1}^{N}$, respectively. This will aid us when we begin training neural networks with large numbers of neurons. MyGrad's `he_normal` will handle all of this for us.

<!-- #endregion -->

```python
from mygrad.nnet.initializers.he_normal import he_normal
```

```python
class Model:      
    def __init__(self, num_neurons, num_classes):
        """
        Parameters
        ----------
        num_neurons : int
            The number of 'neurons', N, to be included in the model.
        
        num_classes : int
            The number of distinct classes that you want your model to predict.
        """
        # set self.N equal to `num_neurons
        self.N = num_neurons  # <COGSTUB>
        
        # set self.num_classes equal to the number of distinct
        # classes that you want your model to be able to predict
        self.num_classes = num_classes  # <COGSTUB>
        
        # Use `self.initialize_params()` to draw random values for
        # `self.w`, `self.b`, and `self.v`. Note that this method does not return anything
        
        # <COGINST>
        self.initialize_params()
        # </COGINST>

    def initialize_params(self):
        """
        Randomly initializes and sets values for  `self.w`,
        `self.b`, and `self.v`.

        Uses `mygrad.nnet.initializers.normal to draw tensor
        values w, v from the he-normal distribution, using a gain of 1.

        The b-values are all initialized to zero.

        self.w : shape-(???)  ... using he-normal
        self.b : shape-(???)  ... as a tensor of zeros
        self.v : shape-(???)  ... using he-normal

        ??? -> you fill in the values
        """
        # Use the attributes `self.N` and `self.num_classes` as-needed
        # to construct the shapes of the tensors

        self.w = he_normal(2, self.N) # <COGSTUB> draw a shape-(???, N) tensor using `he_normal`
        self.b = mg.zeros((self.N,))  # <COGSTUB> draw a shape-(???) tensor using `mg.zeros(<shape-tuple>)`
        self.v = he_normal(self.N, self.num_classes)  # <COGSTUB> draw a shape-(???) tensor using `he_normal`

   
    def __call__(self, x):
        """
        Performs a so-called 'forward pass' through the model
        on the specified data. I.e. uses the linear model to
        make a prediction based on `x`.
        
        Parameters
        ----------
        x : array_like, shape-(M, 2)
            An array of M observations, each a 2D point.
        
        Returns
        -------
        prediction : mygrad.Tensor, shape-(M, num_classes)
            A corresponding tensor of M predictions based on
            the form of the universal approximation theorem.
        """
        # # This is nearly identical to the `Model.__call__` method that you coded for the universal
        # function approximator, when fitting cosine.
        #
        # The one difference is that we are using relu instead of sigmoid
        
        # <COGINST>
        relu_out = relu(x @ self.w + self.b)  # matmul[(M,2) w/ (2, N)] + (N,) --> (M, N)
        out = relu_out @ self.v  # matmul[(M, N) w/ (N, num_tendril)] --> (M, num_tendril)
        return out
        # </COGINST>
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters` 
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model"""
        # return a tuple containing the model's learnable parameters: w, b, and v
        return (self.w, self.b, self.v)  # <COGLINE>
    
    def load_parameters(self, w, b, v):
        self.w = w
        self.b = b
        self.v = v
```

## Computing Accuracy


Because we are solving a classification problem rather than a regression problem, we can measure the accuracy of our predictions. We will write an `accuracy` function which accepts our models predictive scores for a batch of data, shape-(M, 3), and the "truth" labels for that batch, shape-(M,). 

Thus, if score-0 for some point is the maximum score, and the label for that point is 0, then the prediction for that point is correct. 

The function should return the mean classification accuracy for that batch of predictions (a single number between 0 and 1). Write a simple test for your function.

```python
def accuracy(predictions, truth):
    """
    Returns the mean classification accuracy for a batch of predictions.
    
    Parameters
    ----------
    predictions : Union[numpy.ndarray, mg.Tensor], shape=(M, D)
        The scores for D classes, for a batch of M data points
        
    truth : numpy.ndarray, shape=(M,)
        The true labels for each datum in the batch: each label is an
        integer in [0, D)
    
    Returns
    -------
    float
        The accuracy: the fraction of predictions that your model got correct,
        which should be in [0, 1]"""
    # Use `np.argmax` to convert the (M, D) prediction scores (floats)
    # to an array of (M,) predicted integer labels that reside in [0, D)
    predicted_labels = np.argmax(predictions, axis=1)  # <COGSTUB>
    
    # Now we compare the array of predicted labels to the true labels using
    # to produce a shape-(M,) boolean-valued array of `True`/`False` values 
    # where the predictions do (True) or don't (False) match the truth.
    prediction_vs_truth = predicted_labels == truth  # <COGSTUB>
    
    # Lastly, recall that we can perform arithmetic on boolean-valued arrays/tensors. 
    # `True` will behave like 1 and `False` will behave like 0.
    #
    # Compute the fraction correct predictions, which is our prediction accuracy.
    fraction_correct = np.sum(prediction_vs_truth) / len(prediction_vs_truth)  # <COGSTUB>
    
    return fraction_correct
```

Let's test our accuracy function.
We'll create a shape-`(M=3, num_classes=2)` of predictions array, meaning that we have three predictions and each prediction provides a score between two classes.

Look at the particular prediction-scores provided below.

On a piece of paper, write down the prediction scores; for each of the 3 sets of predictions, write down the corresponding predicted label (each one should be either a `0` or a `1`, depending on whether the first or second score is largest).
Compare these predicted labels to the true labels. What fraction of these predictions are correct?

Use your `accuracy` function and check that it returns the expected results.

```python
predictions = np.array(
    [
        [0.1, 10.2],
        [90.0, -2.0],
        [18.0, 0.0],
    ]
)
truth = np.array([1, 1, 0])

# <COGINST>
# The predicted labels are: [1, 0, 0] and the truth is [1, 1, 0]
# Thus we got 2/3 of the predictions correct.

accuracy(predictions, truth)  
# </COGINST>
```

## Our Loss Function

<!-- #region -->
### The softmax activation function

We will be using the "cross-entropy" function for our loss. This loss function is derived from the field of information theory, and is designed to compare probability distributions. This means that we will want to convert the numbers of $\vec{y}_{pred} = F(\{\vec{v}_i\}, \{\vec{w}_i\}, \{b_i\}; \vec{x})$, into numbers that behave like probabilities. To do this, we will use the "softmax" function:

Given an $m$-dimensional vector $\vec{y}$, the softmax function returns a a vector, $\vec{p}$ of the same dimensionality:


\begin{equation}
\text{softmax}(\vec{y}) = \vec{p}
\end{equation}

where

\begin{equation}
p_i = \frac{e^{y_{i}}}{\sum_{j=0}^{m-1}{e^{y_{j}}}}
\end{equation}
<!-- #endregion -->

<!-- #region -->
Convince yourself that the elements of $\vec{p}$ do indeed satisfy the basic requirements of being a probability distribution. I.e. :

- $0 \leq p_i \leq 1$, for each $p_i$
- $\sum_{i=0}^{m-1}{p_i} = 1$

where $m$ is the number of classes in our classification problem.

In the following cell, apply MyGrad's `softmax` function along the rows of the tensor

```python
x = mg.tensor([[10.0, 10.0],
               [-10.0, 10.0]])
```

and study the result. Do the output's respective rows satisfy the aforementioned properties?
Looking at the input `x`, does the output make intuitive sense?
Feel free to play around with various inputs to `softmax` to strengthen your intuition for it.
<!-- #endregion -->

```python
from mygrad.nnet import softmax

# <COGINST>

x = mg.tensor([[10.0, 10.0],
               [-10.0, 10.]])
softmax(x)
# </COGINST>
```

### The cross-entropy loss function


So, armed with the softmax function, we can convert our classification scores, $\vec{y}$, to classification probabilities, $\vec{p}$ (or at the very least, numbers that *act* like probabilities. This opens the door for us to utilize the [cross-entropy loss](https://en.wikipedia.org/wiki/Cross_entropy).

Given our prediction probabilities for the $m$ classes in our problem, $\vec{p}$, we have the associated "true" probabilities $\vec{t}$ (since we are solving a supervised learning problem). E.g., 

- if our point $\vec{x}$ resides in tendril-0, then $\vec{t} = [1., 0., 0.]$
- if our point $\vec{x}$ resides in tendril-1, then $\vec{t} = [0., 1., 0.]$
- if our point $\vec{x}$ resides in tendril-2, then $\vec{t} = [0., 0., 1.]$


In terms of our predictions, $\vec{p}$, and our truth-values, $\vec{t}$, the cross-entropy loss is:

\begin{equation}
\mathscr{L}(\vec{p}, \vec{t}) = -\sum_{i=0}^{m}{t_{i}\log{p_{i}}}
\end{equation}


This loss function measures *how different two probability distributions, $\vec{p}$ and $\vec{t}$ are*. The loss gets larger as the two probability distributions become more disparate, and the loss is minimized (0, specifically) when the two distributions are identical.



## The softmax-crossentropy function

Because it is very common to perform the softmax on the outputs of your model, to "convert them to probabilities", and then pass those probabilities to a cross-entropy function, it is more efficient to have a function that does both of these steps. This is what `mygrad`'s [softmax_crossentropy](https://mygrad.readthedocs.io/en/latest/generated/mygrad.nnet.losses.softmax_crossentropy.html) function does. Take the time to read its documentation.


```python
from mygrad.nnet.losses import softmax_crossentropy
```


Study and run the following cells.
What do the shapes of `p` and `t` correspond to?
Looking at the contents of a given pair of `p` and `t` does the output of `softmax_crossentropy` make sense?

```python
p = np.array([[100., 0., 0.]])
t = np.array([0])

softmax_crossentropy(p, t)
```

<COGINST>
The above describes a single prediction among three classes, where the true class is label-0 and
the highest-confidence prediction is label-0, thus the loss is very small (essentially at the minimum).
</COGINST>

```python
p = np.array([[100., 0., 0.]])
t = np.array([1])

softmax_crossentropy(p, t)
```

<COGINST>
The above describes a single prediction among three classes, where the true class is label-1 and
the highest-confidence prediction is label-0, thus the loss is very large because the model is confidently incorrect.
</COGINST>


```python
p = np.array([[100., 100., 100.]])
t = np.array([0])

softmax_crossentropy(p, t)
```

<COGINST>
The above describes a single prediction among three classes, where the true class is label-0 and
the model is ambivalent as to which class is correct – each class has the same predicted score. Thus
the loss is not as high as before, but still reflects that the model is wrong.
</COGINST>


Run this final cell.
What is the relationship between its output and the outputs of the three cells above?
Verify this relationship explicitly.

```python
p = np.array([[100.,   0.,   0.],
              [100.,   0.,   0.],
              [100., 100., 100.]])

t = np.array([0, 1, 0])

softmax_crossentropy(p, t)
```

<COGINST>
The above describes a three independent predictions, each among three classes, where the true class labels are label-0, label-1, and label-0 respectively.
This captures the first three scenarios in a single set of inputs; `softmax_crossentropy` is designed to compute the average loss across a batch of predictions, thus the output here is: $\frac{0 + 100 + 1.099}{3}$
</COGINST>


## Defining your gradient descent and forward pass functions

```python
def gradient_step(tensors, learning_rate):
    """
    Performs gradient-step in-place on each of the provides tensors 
    according to the standard formulation of gradient descent.

    Parameters
    ----------
    tensors : Union[Tensor, Iterable[Tensors]]
        A single tensor, or an iterable of an arbitrary number of tensors.

        If a `tensor.grad` is `None`for a specific tensor, the update on
        that tensor is skipped.

    learning_rate : float
        The "learning rate" factor for each descent step. A positive number.

    Notes
    -----
    The gradient-steps performed by this function occur in-place on each tensor,
    thus this function does not return anything
    """
    # paste your solution from a previous notebook here
    # <COGINST>
    if isinstance(tensors, mg.Tensor):
        # Only one tensor was provided. Pack
        # it into a list so it can be accessed via
        # iteration
        tensors = [tensors]

    for t in tensors:
        if t.grad is not None:
            t.data -= learning_rate * t.grad
    # </COGINST>
```

<!-- #region -->
Initialize your noggin plotter so that it will track two metrics: loss and accuracy

```python
plotter, fig, ax = create_plot(metrics=["loss", "accuracy"])
```

Also, initialize your model parameters and batch-size. 
- Start off with a small number of neurons in your layer - try $N=3$. Increase number of parameters in your model to improve the quality of your result. You can use the visualization that we provide at the end of this notebook to get a qualitative feel for your notebook
- A batch-size of 50 is fine, but feel free to experiment.
<!-- #endregion -->

```python
# Running this code will recreate your model, re-initializing all of its parameters
# Thus you must re-run this cell if you want to train your model from scratch again.

# - Create the noggin figure using the code snippet above
# - Set `batch_size = 50`: the number of predictions that we will make in each training step
# - Create your model


from noggin import create_plot
plotter, fig, ax = create_plot(metrics=["loss", "accuracy"])

batch_size = 50  # <COGSTUB> set your batch-size to 50

lr = 0.1 # <COGSTUB> specify your learning rate for gradient descent; try using 0.1

# Initialize your Model class using 15 neurons, and the appropriate number of classes (how many tendrils are there?)
# Feel free to change the number of neurons later
model = Model(num_neurons=15, num_classes=num_tendril)  # <COGSTUB> 

```

Referring to the code that you used to train your universal function approximator, write code to train your model on the spiral dataset for a specified number of epochs. Remember to shuffle your training data before you form batches out of it. Also, remember to use the the `softmax_crossentropy` loss.

Try training your model for 1000 epochs. A learning rate $\approx 0.1$ is a sensible starting point. Watch the loss and accuracy curves evolve as your model trains.

Below, you will be able to visualize the "decision boundaries" that your neural network learned. Try adjusting the number of neurons in your model, the number of epochs trained, the batch size, and the learning rate. 

```python
# import the loss function from mygrad, as directed above
from mygrad.nnet.losses import softmax_crossentropy # <COGLINE>


for epoch_cnt in range(1000):

    # `idxs` will store shuffled indices, used to randomize the batches for
    # each epoch
    idxs = np.arange(len(xtrain))  # -> array([0, 1, ..., 9999])
    np.random.shuffle(idxs)

    for batch_cnt in range(0, len(xtrain) // batch_size):
        
        # get the batch-indices from `idxs` (refer to the universal function approx notebook)
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]  # <COGSTUB>

        # Use `batch_indices` to index into `xtrain` and `ytrain`.
        batch = xtrain[batch_indices]  # <COGSTUB> your random batch of data, shape-(M, 2)
        truth = ytrain[batch_indices]  # <COGSTUB> the true labels for this batch, shape-(M,)
        
        predictions = model(batch)  # <COGSTUB> make predictions with your model, shape-(M, 3) tensor of scores

        # Compute the loss associated with our predictions
        # The loss should be a Tensor so that you can do back-prop
        loss = softmax_crossentropy(predictions, truth) # <COGSTUB>

        # Use mygrad compute the derivatives for your model's parameters, so
        # that we can perform gradient descent.
        loss.backward()  # <COGINST>

        # Update your model's parameters using `gradient_step`.
        # Keep in mind that this function updates the parameters in-place; it doesn't return anything.
        gradient_step(model.parameters, lr) # <COGLINE>
        
        # Compute the accuracy of the model's predictions
        acc = accuracy(predictions, truth) # <COGSTUB> use your `accuracy` function

        plotter.set_train_batch(
            {"loss": loss.item(), "accuracy": acc}, batch_size=batch_size
        )
plotter.plot()

# Running this cell will train your model; look back up to the noggin plot to watch
# the loss and accuracy evolve over time
```

This cell will allow you to visualize the decision boundaries that your model learned. We must define a function whose only input is the data, and whose out output is the softmax (**not** softmax crossentropy) of your classification scores.

The red regions are all of the points where your model will say "this is belongs to the red tendril", and so on.
Do you notice any anomalies in these decision boundaries?

```python
# Run this cell

def dummy_function(x):
    from mygrad.nnet.activations import softmax
    with mg.no_autodiff:  # <- this tells mygrad that derivatives will not be needed and thus makes things more efficient
        return softmax(model(x))

fig, ax = data.visualize_model(dummy_function, entropy=False);
```

The following plot will display the "uncertainty" of your model. Purple means that the model is highly confident.
Yellow means that the model is uncertain. 

Do the regions of uncertainty make sense here?

```python
fig, ax = data.visualize_model(dummy_function, entropy=True);
```

Try training your model for more iterations. You should also try adjusting the number of neurons in your model. How do the decision boundaries change when you decrease or increase the number of neurons in the model?

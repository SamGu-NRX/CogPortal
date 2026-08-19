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
from collections import defaultdict

import numpy as np

from mynn.layers.dense import dense
from mynn.optimizers.adam import Adam

from mygrad.nnet.losses import softmax_crossentropy
from mygrad.nnet.initializers import glorot_normal
from mygrad.nnet.activations import relu

import mygrad as mg

%matplotlib notebook
import matplotlib.pyplot as plt
```

# Simple RNN Cell in MyGrad

In this notebook, we will implement a simple RNN model that can be used for sequence classification problems.
We'll apply this RNN to the **classification problem of determining if a sequence of digits (0-9) is the concatentation of two identical halves.**

For example:
- `[1, 2, 3, 1, 2, 3]` -> contains identical halves
- `[1, 9, 2, 1, 8, 3]` -> does not contain identical halves

Our model will take a single sequence of data, $(\vec{x}_t)_{t=1}^T$, stored in a shape $(T, C)$ array, where $T$ is the length of our sequence and $C$ is the embedding dimensionality of each entry in our sequence.
The model will produce $K$ classification scores, assuming there are $K$ classes for the problem. 

In the context of word-embeddings, if each word in our vocabulary has a 50-dimensional word-embedding representation, and we have with a sentence containing 8 words, then $x$ would have a shape $(8, 50$) - representing that sentence numerically. Our model would produce $K$ classification scores for this input data.

**The actual problem that we are solving is the following:**
> Given a sequence of digits, return 1  if the first half and second half of a sequence are identical and 0 otherwise.

We'll be using the following update equations for a simple RNN cell:
<br/>
<br/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; $\vec{h}_t = \operatorname{ReLU}(\vec{x}_t W_{xh} + \vec{h}_{t-1} W_{hh} + \vec{b}_h)$
<br/>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; $\vec{y}_t = \vec{h}_t W_{hy} + \vec{b}_y$

where $\vec{h}_t$ is the hidden (or recurrent) state of the cell and $\vec{x}_t$ is the sequence-element at step-$t$, for $t=1, 2, \dots, T$, where $T$ is the length of our sequence.
The set $\big(\vec{y}_t\big)_{t=1}^T$ is the output;
_however_, for this particular problem, we will only use the classification scores from the final $y_T$.
The $W_{xh}, W_{hh}, W_{hy}$ and $\vec{b}_{h}, \vec{b}_{y}$ parameters are the *learnable parameters of our model*. Specifically: 

- $\vec{x}_t$ is a descriptor-vector for entry-$t$ in our sequence of data. It has a shape-$(1, C)$.
- $\vec{h}_t$ is a "hidden-descriptor", which encodes information about $\vec{x}_t$ *and* information about the preceding entries in our sequence of data, via $\vec{h}_{t-1}$. It has a shape-$(1, D)$, where $D$ is the dimensionality that we choose for our hidden descriptors (akin to layer size).
- $W_{xh}$ and $\vec{b}_h$ hold dense-layer weights and biases, respectively, which are used to process our data $\vec{x}_t$ in order to form $\vec{h}_t$. Thus $W_{xh}$ has shape $(C, D)$ and $\vec{b}_h$ has shape-$(1,D)$. 
- $W_{hh}$ hold dense-layer weights, which are used to process our previous hidden-descriptor $\vec{h}_{t-1}$ in order to form $\vec{h}_t$. Thus $W_{hh}$ has shape $(D, D)$.
- $W_{hy}$ and $\vec{b}_y$ hold dense-layer weights and biases, respectively, which are used to process our hidden-descriptors $\vec{h}_t$ in order to produce our classification scores, $y_t$. Thus $W_{hy}$ has shape $(D, K)$ and $\vec{b}_h$ has shape-$(1,K)$, where $K$ is our number of classes. For this problem, given our input sequence $(\vec{x}_t)_{t=1}^T$, we ultimately want to use the classification scores $y_T$ of shape-$(1, K)$.

The basic idea is to have the forward pass in the model iterate over all elements in the input sequence, applying the update equations at each step.

Then we'll compute the loss between the final output $y_T$ and the target classification, perform backpropagation through the computational graph to compute gradients (known as "backpropagation through time" or "BPTT" in RNNs), and update parameters using some form of gradient descent.




## Define Recurrent Model Class

First create a recurrent model class using MyGrad and MyNN with the following properties:
* `__init__`
 * Takes three parameters: dim_input ($C$), dim_recurrent ($D$), dim_output ($K$)
 * Creates three dense layers (required for update equations)
  * Note: one of the dense layers doesn't need a bias since it would be redundant. You can specify `bias=False` when initializing your dense layer.
  * You can leave the bias out of the dense layer corresponding to $W_{hh}$
* `__call__`
 * If an initial hidden state $\big(\vec{h}_{t=0}\big)$ is not provided, creates the initial hidden state as an array of zeros, shape-(1, D)
 * Iterates over the $T$-axis (rows) of the input sequence $(\vec{x}_t)_{t=1}^T$ and computes and stores the successive hidden states $\vec{h}_{t=1},\; \vec{h}_{t=2},\; \dots,\; \vec{h}_{t=T}$
 * After processing the all $T$ items in your sequence, computes the outputs $\vec{y}_1,\; \vec{y}_2,\; \dots,\; \vec{y}_T$ and returns both the outputs and the hidden states as shape $(T,K)$ and $(T,D)$ tensors, respecitvely
* `parameters`
 * Returns the tuple of all the learnable parameters in your model.

As we ultimately want to use the final prediction scores $\vec{y}_T$ in our loss, in our training loop we will need to extract this from the output of our `RNN` class. We will feed the shape `(1, K)` scores from $\vec{y}_T$ to a softmax-crossentropy loss and so there is no need for an activation function on $\vec{y}_T$, as softmax is built into the loss.

Use `glorot_normal` for your dense weight initializations.

```python
class RNN():
    """Implements a simple-cell RNN that produces both outputs and hidden descriptors."""
    def __init__(self, dim_input, dim_recurrent, dim_output):
        """ Initializes all layers needed for RNN
        
        Parameters
        ----------
        dim_input: int 
            Dimensionality of data passed to RNN (C)
        
        dim_recurrent: int
            Dimensionality of hidden state in RNN (D)
        
        dim_output: int
            Dimensionality of output of RNN (K)
        """
        # Initialize one dense layer for each matrix multiplication that appears
        # in the simple-cell RNN equation; name these "layers" in ways that make
        # their correspondence to the equation obvious
        # <COGINST>
        self.fc_x2h = dense(dim_input, dim_recurrent, weight_initializer=glorot_normal)
        self.fc_h2h = dense(dim_recurrent, dim_recurrent, weight_initializer=glorot_normal, bias=False)
        self.fc_h2y = dense(dim_recurrent, dim_output, weight_initializer=glorot_normal)
        # </COGINST>
    
    
    def __call__(self, x, h=None):
        """ Performs the full forward pass for the RNN.
        
        Note that we will return the hidden states h_t and classification scores y_t for the
        full sequence, even though our loss will only utilize the last y_T.
        
        Parameters
        ----------
        x: Union[numpy.ndarray, mygrad.Tensor], shape=(T, C)
            The one-hot encodings for the sequence
        
        h: Optional[Union[numpy.ndarray, mygrad.Tensor]], shape=(1, D)
            An optional initial hidden dimension state h_0.
            If None, initialize an array of zeros.
        
        Returns
        -------
        Tuple[y, h]
            y: mygrad.Tensor, shape=(T, K)
                The final classification scores for each RNN step
            h: mygrad.Tensor, shape=(T, D)
                The hidden states computed at each RNN step, excluding the initial state h_0
        """
        # Initialize the hidden state h_{t=0} as zeros if an
        # initial hidden state is not provided as an argument.
        #
        # You will want to loop over each x_t to compute the
        # corresponding h_t, then store each h_t in a list.
        # You do not want to store the initial state h_{t=0}.
        #
        # You can use `mg.concatenate(list_of_h, axis=0)` to
        # create a shape-(T, K) tensor of hidden-descriptors.
        #
        # A standard for-loop is appropriate here. Be mindful of what the shape 
        # of x_t should be versus the shape of the item that it produced by the
        # for-loop.
        #
        # Note that you can do a for-loop over a mygrad-tensor and it will
        # produce sub-tensors that are tracked by the computational graph.
        # I.e. mygrad will be able to still "backprop" through your for-loop!
        
        # <COGINST>
        h_t = np.zeros((1, self.fc_h2h.weight.shape[0]), dtype=np.float32) if h is None else h
        h = [] # we do not need to store the initial state, as we do not return it/use it to compute y
        
        for x_t in x:
            # `x_t[np.newaxis]` simply reshapes `x_t`: (C,) -> (1, C)
            #
            # h_t: shape-(1, D) hidden descriptor
            h_t = relu(self.fc_x2h(x_t[np.newaxis]) + self.fc_h2h(h_t))
            h.append(h_t)
        
        # shape-(T, D) collection of T descriptors (each shape-(D,))
        all_h = mg.concatenate(h, axis=0)
        
        # `all_y` is:
        # a shape-(T, K) collection of T "prediction scores", one produced
        # in association with each of the T hidden descriptors.
        #
        # We will only be making use of `all_y[-1:]` for our prediction
        # in our notebook; this is the shape-(1, K) vector associated with y_T
        all_y = self.fc_h2y(all_h)
        return all_y, all_h
        # </COGINST>
    
    
    @property
    def parameters(self):
        """ A convenience function for getting all the parameters of our model.
        
        This can be accessed as an attribute, via `model.parameters` 
        
        Returns
        -------
        Tuple[Tensor, ...]
            A tuple containing all of the learnable parameters for our model
        """
        return self.fc_x2h.parameters + self.fc_h2h.parameters + self.fc_h2y.parameters # <COGLINE>
```

<!-- #region -->
## Data Generation

We'll apply this new network to the **problem of determining if a sequence of digits (0-9) is the concatentation of two identical halves.**

For example:
- `[1, 2, 3, 1, 2, 3]` -> contains identical halves
- `[1, 9, 2, 1, 8, 3]` -> does not contain identical halves

We will be representing each digit using the so-called "**one-hot encoding**"
 * 0 $\longrightarrow$ [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
 * 1 $\longrightarrow$ [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
 * 2 $\longrightarrow$ [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]
 * 3 $\longrightarrow$ [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
 * $\vdots$
 * 9 $\longrightarrow$ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
 
Thus a sequence of $T$ one-hot encoded digits will be represented by a shape-$(T,C=10)$ array. 

For example, the sequence
```python
# length-4 sequence
array([2, 0, 2, 0])
```
Would have the one-hot encoding
```python
# shape-(4, 10)
array([[ 0.,  0.,  1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 0.,  0.,  1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.]])
```

Create a function to generate a sample sequence that does the following:
* allows you to specify min and max pattern length
* randomly chooses a pattern length in the specified range
* randomly generates a sequence of integers (0 through 9) of that length
* sets first half of sequence equal to pattern
* randomly chooses whether first and second half of sequence should match or not (with probability 0.5)
* creates second half of sequence accordingly
* creates float32 numpy array `x` of shape $(T, 10)$ where row i is one-hot encoding of item i in sequence
* creates int16 numpy array `y` of shape $(1,)$ where `y = array([1])` if the patterns match and `array([0])` otherwise
* returns `(x, y, sequence)` (note that sequence is returned mainly just for debugging)

Note: `np.random.rand() < 0.5` returns `True` with 50% probability. This will come in handy!

For example, if you randomly generate the sequence [2, 0, 2, 0] (which has a pattern-length of 2, whose first half does match the second half, which should occur 50% of the time), the output of your function should be:
```python
# x: one-hot encoded version of the sequence, shape-(4,10)
array([[ 0.,  0.,  1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 0.,  0.,  1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.],
       [ 1.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.,  0.]])     

# y: the halves of the sequence do match -> 1
array([ 1])

# sequence
array([2, 0, 2, 0])
```
<!-- #endregion -->

```python
def generate_sequence(pattern_length_min=1, pattern_length_max=10, palindrome=False):
    """
    Randomly generate a sequence consisting of two equal-length patterns of digits,
    concatenated end-to-end. 
    
    There should be a 50% chance that the two patterns are *identical* and a 50% 
    chance that the two patterns are distinct.
    
    Parameters
    ----------
    pattern_length_min : int, optional (default=1)
       The smallest permissable length of the pattern (half the length of the 
       smallest sequence)
       
    pattern_length_max : int, optional (default=10)
       The longest permissable length of the pattern (half the length of the 
       longest sequence)
       
    palindome : bool, optional (default=False)
        If `True`, instead of a sequence with the two identical patterns, generate
        a palindrome instead.
    
    Returns
    -------
    Tuple[numpy.ndarray, numpy.ndarray, numpy.ndarray]
        1. the one-hot encoded sequence; shape-(T, 10)
        2. the label for the sequence: 0 (halves don't match), 1 (halves match); shape-(1,)
        3. the actual sequence of digits; shape-(T,)
    """
    # 1. Use np.random.rand() to do "a coin flip"-like decision, to decide if you will be generating a matched 
    #    example (e.g. [1, 2, 3, 1, 2, 3] or an un-matched one (e.g. [1, 2, 3, 2, 2, 1])
    #
    # 2. Draw a half pattern-length – T-half – from numpy.random.randint (note that its upper-bound is exclusive)
    #
    # 3. Generate a shape-(T-half,) array of random integers
    #
    # 4. 
    #   - If your "coin flip" indicated "match" then create an array that contains that half pattern repeated twice
    #   - If your "coin flip" indicated "not-match" then draw another half array, make sure it doesn't happen to match
    #     the first half (if it does, re-sample it), and then concatenate them together
    #
    # 5. Create a shape-(1,) array containing 0 if the generated data is non-matching and 1 if the data is matching
    #
    # 6. Create a shape-(T, 10) one-hot encoding array that represents each of T digits in your generated data as a 
    #    shape-(10,) one-hot vector. E.g. 0 -> [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    #
    # 7. Consult the Returns section of the docstring to see what to return
    
    # <COGINST>
    pattern_length = np.random.randint(pattern_length_min, pattern_length_max + 1)
    pattern = np.random.randint(0, 10, pattern_length)
    match = np.random.rand() >= 0.5
    
    sequence = np.zeros(2 * pattern_length, dtype=np.int64)
    sequence[:pattern_length] = pattern
    if match:
        sequence[pattern_length:] = pattern[::-1] if palindrome else pattern
    else:
        # non-matching second half
        second_half = np.random.randint(0, 10, pattern_length)
        while np.array_equal(second_half, pattern):
            second_half = np.random.randint(0, 10, pattern_length)
        sequence[pattern_length:] = second_half
    
    # one-hot encoding of digits 0 through 9
    # x = np.zeros(pattern_length * 2, 10, dtype)
    x = np.zeros((len(sequence), 10), dtype=np.float32)
    y = np.array([1.0 if match else 0], dtype=np.int16)

    for i, ch in enumerate(sequence):
        x[i, ch] = 1
    
    return x, y, sequence
    # </COGINST>
```

Test your `generate_sequence` function manually.
- Does it produce sequences within the desired length bounds?
- Does `x` correspond to `sequence`, with the appropriate one-hot encoding?
- Does `y` indicate `array([1])` when the halves of the sequence match?

Consider writing some code with assert statements that will raise if any of these checks fail.

```python
# <COGINST>
# these checks are optional

for i in range(100):
    x, y, seq = generate_sequence()
    assert len(x) == len(seq)
    assert np.all(seq[:len(seq)//2] == seq[-len(seq)//2:]).item() is bool(y.item())
    assert np.all(x[:len(x)//2] == x[-len(x)//2:]).item() is bool(y.item())
# </COGINST>
```

Set up a noggin plot, as you will want to observe the loss and accuracy during training.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(["loss", "accuracy"])
```

Recall that each digit has a one-hot encoding, which means that $C=10$ (`input_dim`). A sensible hidden-descriptor dimensionality is $D=50$ (`dim_recurrent`). Lastly, we are solving a *two-class* classification problem ($0\rightarrow$ no pattern match, $1\rightarrow$ pattern match), and thus $K=2$ (`dim_output`). Initialize your model accordingly.

Set up an Adam optimizer. Pass the Adam optimizer your model's learnable parameters. Otherwise use its default learning rate and other hyperparameters. Feel free to mess with these later.



```python
model = RNN(dim_input=10, dim_recurrent=50, dim_output=2)  # <COGSTUB>
optimizer = Adam(model.parameters)  # <COGSTUB>
```

<!-- #region -->
Train the model for 100000 iterations. Instead of pre-generating a set of training sequences, we'll use a strategy of randomly sampling a new input sequence every iteration using the method you created earlier. Use pattern_length_min = 1 and pattern_length_max = 10.

**Do not plot batch-level metrics. We will be processing so many sequences, that plotting all the losses and accuracies will become a performance bottleneck**. You can set your loss and accuracy for each batch without plotting, using 

```python
plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, 
                        batch_size=1, 
                        plot=False)
```

And then for every 500th batch (or whatever you want), call:

```python
plotter.set_train_epoch()
```

This will plot mean statistics for your model's performance instead of the accuracy and loss for every single input.

**Take care to only pass in the final predicted value** $y_T$ **to the loss as a shape** $(1,K)$ **tensor**.

After your training loop has completed one successful iteration, you can run `mg.turn_memory_guarding_off()`.
This will speed up all subsequent iterations of your training loop.
If you are interested to learn what this is all about, you can read about it [here](https://mygrad.readthedocs.io/en/latest/performance_tips.html#controlling-memory-guarding-behavior).
<!-- #endregion -->

```python
mg.turn_memory_guarding_off()
plot_every = 500

for k in range(100_000):
    x_one_hot, target, sequence = generate_sequence(palindrome=False)  # <COGSTUB> generate your training-example & label
    
    # Use your model to process the shape-(T, 10) one-hot encoded data
    # Note that we are not training on batches here. We are training on one shape-(T, 10)
    # example at a time.
    # <COGINST>
    output, _ = model(x_one_hot)
    # </COGINST>
    
    # Our model will produce a shape-(T, 2) output. We only want to
    # use the last prediction of the T outputs. 
    #
    # Access the last of the T outputs and reshape it to be a shape-(1, 2)
    # tensor. This will be our model's classification for 1 sequence, given two classes (not-match / match)
    #
    # <COGINST>
    # We only want to use the final prediction scores.
    # `output[-1:]` returns y_T as shape-(1, D) tensor.
    #
    # `output[-1]` would return shape-(D,) tensor, which will
    # produce a shape issue
    output = output[-1:]
    # </COGINST>
        
    loss = softmax_crossentropy(output, target)  # <COGSTUB> compute the softmax-crossentropy loss of prediction vs truth 
    
    acc = float(np.argmax(output.data.squeeze()) == target.item())  # 1.0 if prediction is correct, else 0.0

    plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, batch_size=1, plot=False)
    
    if k % plot_every == 0 and k > 0:
        plotter.set_train_epoch()
    
    # Trigger backpropagation to compute dL/dw for all model parameters
    # Use the optimizer to update the parameters using the gradient-based step
    # <COGINST>
    loss.backward()
    optimizer.step()
    # </COGINST>
```

<!-- #region -->
### Accuracy vs Sequence Length

Create a plot of accuracy vs sequence length. To do so, randomly generate sequences (which will be of various lengths), apply the trained model to get the predicted outputs, and record whether the model predictions are correct or not. Then compute accuracy for sequences of length 2, for sequences of length 4, etc. (hint: Keep track of total and total correct for each possible length).

MyGrad note: Because you'll be evaluating the model on many sample sequences (`output = model(x)`), it's important to run this code in the `mg.no_autodiff` context:

```python
with mg.no_autodiff:
   # autodiff is disabled here,
   # thus mygrad will run faster
```
<!-- #endregion -->

```python

length_total = defaultdict(int)  # <COGSTUB> A counter that tallies: seq-len -> total number of sequences with this length
length_correct = defaultdict(int)  # <COGSTUB> A counter that tallies: seq-len -> number of sequences of this length that model classified correctly

# generate ~10,000 examples and update the `length_total` and `length_correct`counters for each example
# <COGINST>
with mg.no_autodiff:
    for i in range(10_000):
        if i % 5_000 == 0:
            print("i = %s" % i)
        x, target, sequence = generate_sequence()

        output, _ = model(x)
        output = output[-1:]

        length_total[len(sequence)] += 1
        if np.argmax(output.data.squeeze()) == target.item():
            length_correct[len(sequence)] += 1

# </COGINST>
```

```python
fig, ax = plt.subplots()
x, y = [], []

for i in range(2, 20, 2):
    x.append(i)
    y.append(length_correct[i] / length_total[i])

ax.plot(x, y, marker="o");
ax.set_xlabel("Sequence Length")
ax.set_ylabel("Model Accuracy")
ax.set_ylim(0, 1)
ax.grid()
```

What do you notice about accuracy as sequence length increases? Is this expected? What might make long sequences hard to deal with? Discuss with a neighbor!

What happens if you apply the model to a sequence that's longer than examples it's been trained on? What happens if we train on and try to classify palindromes? Try messing around with our model and exploring the results.

```python
# Testing your model
from typing import Sequence

def to_one_hot(seq: Sequence[int]) -> np.ndarray:
    x_one_hot = np.zeros((len(seq), 10), dtype=np.float32)
    for i, ch in enumerate(seq):
        x_one_hot[i, ch] = 1
    return x_one_hot

def predict_is_match(seq: Sequence[int]) -> bool:
    """Uses trained model to see if a sequence consists of two matching halves or not.
    
    Parameters
    ----------
    seq : Sequence[int]
        A sequence of integers
    
    Returns
    -------
    is_matched : bool
        The model's prediction: True if the model think the first and second
        halves of the sequence match"""
    return bool(np.argmax(model(to_one_hot(seq))[0][-1]).item() == 1)


```

```python
# Test your model out here. Try writing your own examples -- see if you can get your model to be wrong

assert predict_is_match([1, 2, 3, 1, 2, 3])
assert not predict_is_match([0, 0, 1, 1])
```

### View the computational graph formed from processing a sequence

We can view the computational graph that results from feeding a sequence through the RNN using MyGrad's awesome `build_graph` capability. (Note: this might not work on windows :( )

```python
from mygrad.computational_graph import build_graph
x, target, sequence = generate_sequence()

output, _ = model(x)
output = output[-1:]

loss = softmax_crossentropy(output, target)
build_graph(loss, names=locals(), render=True)
```

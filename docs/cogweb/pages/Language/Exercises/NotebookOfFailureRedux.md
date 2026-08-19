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

<!-- #region -->
# Notebook of Failure Redux

(aka sequence reversal problem with RNNs)

As we previously saw, a RNN is natural model architecture to use when working with sequential data, such as text.
And when working with language, a natural problem that arises is that of _translation_.
In this notebook, we will explore a simple machine translation problem: reversing a sequence of digits.
E.g.

\begin{align}
[2, 4, 7, 1, 3] &\longrightarrow [3, 1, 7, 4, 2]
\end{align}



Sounds easy enough, right?
<!-- #endregion -->

## Generating the Data

<!-- #region -->
As we did with classifying sequences that had identical halves, we will represent each digit in our sequence with a one-hot encoding.
Unlike our previous sequences though, we will being to apply special start and end tokens to denote the beginning and end of our sequences.
In particular, we will have a start token correspond to `10`, and and end token correspond to `11`.
So when we one-hot encode our new 'vocabulary', we will have the following shape-(12,) vectors:

\begin{align}
0 &\longrightarrow [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] \\
&\;\;\vdots \\
9 &\longrightarrow [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] \\
\langle\text{Start}\rangle=10 &\longrightarrow [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0] \\
\langle\text{End}\rangle=11 &\longrightarrow [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] \\
\end{align}

Note that we will not be making use of the `<START>` token in our data generation for this simple-cell RNN model, but we will use it when we create a "sequence-to-sequence" model in the coming notebook.

For our simple RNN model, we will only need to utilize the end token when generating our data.
So for a sequence `[4, 7, 5, 1]`, we will want to create a one-hot encoding of

```python
[[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]  # 4 
 [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]  # 7
 [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]  # 5
 [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]  # 1
 [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]] # <End> (11)
```

and have target labels of `[1, 5, 7, 4, 11]`, which is the sequence in reverse.
<!-- #endregion -->

Additionally, to make the learning process more efficient, we will want to make batches of sequences to pass to our model during training.

For a batch-size $N$ an original digit-sequence length of $T-1$, we will have the input to our model will be a shape $(T, N, C=12)$ array of one-hot encodings.
While this differs from how we have handled batches in the past, where the $0^\text{th}$ dimension was associated with the $N$ samples in the batch, notice that we will ultimately compute the same dot products due to how NumPy broadcasts matrix multiplication:

```python
T, N, C = 2, 3, 4
seq_then_batch = np.arange(T * N * C).reshape(T, N, C)
batch_then_seq = seq_then_batch.transpose(1, 0, 2)

arr = np.arange(C * 5).reshape(C, 5)

# shape-(T, N, C) x shape-(C, 5) -> shape-(T, N, 5)
seq_then_batch = seq_then_batch @ arr

# shape-(N, T, C) x shape-(C, 5) -> shape-(N, T, 5)
batch_then_seq = batch_then_seq @ arr

np.all(seq_then_batch == batch_then_seq.transpose(1, 0, 2))
```

With the two considerations from above kept in mind, write a function `generate_batch` that takes in a minimum and maximum possible sequence length and a batch size that will:

1. Randomly generate a digit-sequence length, $T-1$, between the provided minimum and maximum.
2. Randomly generate a `batch_size`-number of sequences of digits. The batch-size is represented by $N$.
3. Create a dtype-`float32` array of one-hot encodings of the sequences of digits.
4. Append the one-hot encoding of the `<END>` token to each sequence in the batch.
5. Creates target sequences of digits by simply reversing the randomly generated integers and appending an end token.
6. Returns a tuple containing:
    1. the one-hot encodings of the original batch of sequences
    2. the reversed, target sequences (as sequences of integers, not one-hot encodings)
    3. the original randomly generated batch of sequences

```python
def generate_batch(seq_len_min=1, seq_len_max=20, batch_size=10):
    """
    Generates a batch of sequences and corresponding one-hot encodings.
    
    Each digit-sequence has a length of T-1 (not including the <END> token),
    where the value for T-1 is randomly generated.
    
    Parameters
    ----------
    seq_len_min : int, optional (default=1)
       The smallest permissable length of the pattern,
       excluding start and end tokens
       
    seq_len_max : int, optional (default=20)
       The longest permissable length of the pattern,
       excluding start and end tokens
       
    batch_size : int, optional (default=10)
        The number of sequences to generate
    
    Returns
    -------
    Tuple[numpy.ndarray, numpy.ndarray, numpy.ndarray]
        1. the one-hot encoded sequences, including an end token; shape-(T, N, 12)
        2. the target sequences, including an end token; shape-(T, N)
        3. the original sequences of digits; shape-(T-1, N)
    """

    # Randomly generate a sequence length in [seq_len_min, seq_len_max]
    # This is the value T-1
    T_1 = np.random.randint(seq_len_min, seq_len_max + 1)  # <COGLINE>

    # Randomly generate the shape-(T-1, N) sequence of digits [0-9]. This
    # represents the N integer-valued sequences of length T-1 that our model
    # will be translating
    #
    # E.g. If T-1 = 3 and N = 2, this might produce:
    #
    #  array([[3, 9],
    #         [2, 5],
    #         [9, 3]])
    # seq-0: 3, 2, 9
    # seq-1: 9, 5, 3
    #
    # Assign this to the variable `digits`
    digits = np.random.randint(0, 10, (T_1, batch_size))  # <COGLINE>

    # Create an array of zeros to fill with one-hot encodings of sequences.
    # This should have a shape of (T, N, 12) and a dtype of float-32.
    #
    # The sequence length is T because the source sequence
    # needs to include the end token (but not start)
    #
    # Call this array `one_hot_x`
    one_hot_x = np.zeros((T_1 + 1, batch_size, 12), dtype=np.float32)  # <COGLINE>

    # Use `digits` to populate `one_hot_x` with the appropriate one-hot encodings.
    #
    # You can achieve this either via advanced indexing:
    # one_hot_x[np.arange(T_1).reshape(-1, 1), np.arange(batch_size), digits] = 1
    # 
    # Or by using a for-loop:
    # for ind in np.ndindex(digits.shape):
    #     one_hot_x[ind + (digits[ind],)] = 1
    # <COGINST>
    one_hot_x[np.arange(T_1).reshape(-1, 1), np.arange(batch_size), digits] = 1
    # </COGINST>

    # In `one_hot_x`, at the last token position for all batches, set the <END> token's one-hot encoding
    #
    # Hint: Recall that `one_hot_x` has a shape of (T, N, 12).
    # We want to access the T-th sequence entry and the 12th encoding position in this array
    # for all N batches using basic indexing. And we want to set all elements in this selected
    # subarray to 1.
    one_hot_x[-1, :, -1] = 1  # <COGLINE>

    # Create the "target" sequences, which are simply the reversed input sequences.
    # This should be a shape-(T, N) array, where the T-th row is filled with `11`, 
    # which is the <END> token.
    # <COGINST>
    ends = np.full(batch_size, 11).reshape(1, -1)
    y = np.concatenate([digits[::-1], ends], axis=0)
    # </COGINST>

    # Return the appropriate arrays - in accordance with the docstring.
    return one_hot_x, y, digits  # <COGLINE>
```

Run the following cell to test your `generate_batch` implementation.

```python
x, y, seq = generate_batch()

assert np.all(y[-2::-1] == seq) # check target labels are original sequences reversed
assert np.all(y[-1] == 11) # check target labels include end token
assert np.all(np.argmax(x[:-1], axis=-1) == seq) # check correct one-hot encodings of sequences
assert np.all(np.argmax(x[-1], axis=-1) == 11) # check correct one-hot encoding of end token

print("Success!")
```

## Defining our Model


Define your RNN class below.
Because our data have dim-0 as the sequence dimension and dim-1 as the batch dimension, we can easily iterate over all of the sequences in our batch at once.
Only slight modifications will need to be made in order to accomodate batches of data.

As before, use `glorot_normal` to initialize your learnable weights.

```python
class RNN:
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
        # <COGINST>
        self.fc_x2h = dense(dim_input, dim_recurrent, weight_initializer=glorot_normal)
        self.fc_h2h = dense(dim_recurrent, dim_recurrent, weight_initializer=glorot_normal, bias=False)
        self.fc_h2y = dense(dim_recurrent, dim_output, weight_initializer=glorot_normal)
        # </COGINST>
    
    
    def __call__(self, x, h=None):
        """ Performs the full forward pass for the RNN.
        
        Parameters
        ----------
        x: Union[numpy.ndarray, mygrad.Tensor], shape=(T, N, C)
            The one-hot encodings for the each sequence in the batch
        
        h: Optional[Union[numpy.ndarray, mygrad.Tensor]], shape=(1, N, D)
            An optional initial hidden dimension state h_0.
            If None, initialize an array of zeros.
        
        Returns
        -------
        Tuple[y, h]
            y: mygrad.Tensor, shape=(T, N, K)
                The final classification scores for each RNN step
            h: mygrad.Tensor, shape=(T, N, D)
                The hidden states computed at each RNN step, excluding the initial state h_0
        """
        # <COGINST>
        # the only change needed to accomodate batches of data is adding `x.shape[1]`
        # as dim-1 of the initial h_t if none is provided
        h_t = np.zeros((1, x.shape[1], self.fc_h2h.weight.shape[0]), dtype=np.float32) if h is None else h
        h = []
        
        for x_t in x:
            h_t = relu(self.fc_x2h(x_t[np.newaxis]) + self.fc_h2h(h_t))
            h.append(h_t)
        
        h = mg.concatenate(h, axis=0)
        
        return self.fc_h2y(h), h
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

Create a noggin plot below to track the loss and accuracy of the model as it trains.

```python
from noggin import create_plot
plotter, fig, ax = create_plot(["loss", "accuracy"]) # <COGLINE>
```

Initialize the RNN and an Adam optimizer.
As we are trying to predict a sequence of digits, each output $y_t$ should contain a classification score for each possible predicted token – all digits and the start and end tokens.
Thus the dimension of the output $K$ must be the same as the dimension of the input $C$.

As before, a `dim_recurrent` of $D=50$ and the default Adam parameters are reasonable starting choices.

```python
# <COGINST>
model = RNN(dim_input=12, dim_recurrent=50, dim_output=12)
optimizer = Adam(model.parameters)
# </COGINST>
```

Write the training loop below.
Use the default `batch_size` of $10$ to start, with `seq_len_min=1` and `seq_len_max=20`.
Train for `20000` iterations.

As before, we will use `softmax_crossentropy` as our loss function.
However, MyGrad's implementation of `softmax_crossentropy` requires the first input `x` to be shape `(N, C)` and the second input `y_true` to be shape `(N,)`.
Since we are working with batchs of sequences, the output of our model will be shape `(T, N, C)` and our truth values will be shape `(T, N)`.
To make our inputs compatible with `softmax_crossentropy`, we can reshape `x` and `y_true` to `(T * N, C)` and `(T * N,)`, respectively.
This will allow us to compute and average the per-token softmax-crossentropy loss, without having to redefine our own version of the loss function.

```python
# <COGINST>
batch_size=10
plot_every=500

for k in range(20000):
    x, target, sequence = generate_batch(batch_size=batch_size)

    # unlike the simple cell RNN used for classification,
    # we want to keep the full output for our loss
    # as we want to translate each digit to a new one
    output, _ = model(x)
    
    loss = softmax_crossentropy(output.reshape(-1, 12), target.reshape(-1))
    loss.backward()
    optimizer.step()
    
    acc = np.mean(np.argmax(output, axis=-1) == target)

    plotter.set_train_batch({"loss":loss.item(), "accuracy":acc}, batch_size=batch_size, plot=False)
    
    if k % plot_every == 0 and k > 0:
        plotter.set_train_epoch()
# </COGINST>
```

Run the following code to evaluate your model. What do you see and are the results surprising to you? Discuss with a neighbor.

```python
length_total = defaultdict(int)
length_correct = defaultdict(int)

with mg.no_autodiff:
    for i in range(100000):
        if i % 10000 == 0:
            print(f"i = {i}")
        x, target, sequence = generate_batch(1, 20, 1)

        output, _ = model(x)

        length_total[sequence.size] += 1
        if np.all(np.argmax(output, axis=-1) == target):
            length_correct[sequence.size] += 1

fig, ax = plt.subplots()
x, y = [], []
for i in range(1, 20):
    x.append(i)
    y.append(length_correct[i] / length_total[i])
ax.plot(x, y);
```

While the model appears to do very well for length-1 sequences, it seems to fail quite miserably on any larger sequence.

Let's think about why this might be for a little.
Because the RNN sequentially iterates over the data, it can only ever have information about preceding tokens when making a predication.
But in our toy problem, we need to have information about _succeeding_ tokens in order to make informed predictions.

For length-1 sequences, the model simply needs to return $\vec{x}_1$ as $\vec{y}_1$, since the reverse of a length-1 sequence is itself.
The RNN can do this quite easily, as every time it predicts a $\vec{y}_t$, it has information about $\vec{x}_t$ as well as about all of $(\vec{x}_i)_{i=0}^{t-1}$ via the hidden state.

However for a length-2 sequence, when predicting $\vec{y}_0$, the RNN needs to know $\vec{x}_1$.
The sequential structure of the RNN simply means this is impossible!
While the RNN could successfully predict the second half of the sequence, $\vec{y}_1$ (because it now knows about the first half of the sequence, $\vec{x}_0$) it means that the roughly $0.1\%$ accuracy for length-2 sequences is no better than simply guessing the first digit!

Simply put, the fact that the RNN processes sequences from sequentially from start to finish means that it is incapable of solving our toy problem!
It also means that it is an ill-suited model for real translation applications, where word order is not necessarily the same in two languages.
In the next notebook, we will look at how we can use RNNs as a building block for a more suitable type of model for translation.
